import { Component } from '@angular/core';
import { Http } from '@angular/http';
import { max, min, padStart } from 'lodash';
import 'rxjs/add/operator/toPromise';

interface PrometheusSeries {
  values: any[];
  metric: {
    __name__?: string;
  };
}

interface PrometheusResponseData {
  result: PrometheusSeries[];
  resultType: string;
}

interface PrometheusQueryResponse {
  status: string;
  data: PrometheusResponseData;
}

interface ChartJsSeries {
  data: any[];
  label: string;
  pointRadius?: number;
  pointHitRadius?: number;
}

interface ChartJsDataset {
  data: ChartJsSeries[];
  labels: any[];
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent {

  // Template parameters.
  busy = false;
  usageData: ChartJsDataset;
  speedData: ChartJsDataset;
  readonly usageChartOptions;
  readonly speedChartOptions;

  prometheusHost = '192.168.0.254:9090';
  samplingInterval = '6h';
  startDateString: string;
  endDateString: string;
  tgrace = 3600;

  constructor (private http: Http) {
    this.endDateString = this.toISODate(new Date());
    this.startDateString = this.toISODate(
      new Date((new Date()).getTime() - 30*24*60*60*1000));

    this.usageChartOptions = {
      scales: {
        xAxes: [{
          ticks: {
            callback: dt => `${dt.getMonth()+1}/${dt.getDate()}`,
          },
        }],
        yAxes: [{
          ticks: {
            callback: bytes => this.formatBytes(bytes),
          },
        }],
      },
      elements: {line: {tension: 0}},
      responsive: true,
      tooltips: {
        callbacks: {
          label: item => this.formatBytes(item.yLabel),
        },
      },
    };
    this.speedChartOptions = {
      scales: {
        xAxes: [{
          ticks: {
            callback: dt => `${dt.getMonth()+1}/${dt.getDate()}`,
          },
        }],
        yAxes: [{
          ticks: {
            callback: bytes => this.formatBytes(bytes) + '/s',
          },
        }],
      },
      elements: {line: {tension: 0}},
      responsive: true,
      tooltips: {
        callbacks: {
          label: item => this.formatBytes(item.yLabel) + '/s',
        },
      },
    };
  }

  toISODate(datetime: Date): string {
    return datetime.getFullYear() + '-' +
      padStart(datetime.getMonth() + 1, 2, '0') + '-' +
      padStart(datetime.getDate(), 2, '0');
  }

  readonly units: string[] = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'EiB'];
  formatBytes(bytes: number): string {
    let unit: string;
    for (unit of this.units) {
      if (bytes < 1000) {
        break;
      }
      bytes /= 1024;
    }
    return `${bytes.toFixed(2)} ${unit}`;
  }

  async queryPrometheus(query: string, start: Date, end: Date, step: string = "1m"): Promise<PrometheusResponseData> {
    let url = `http://${this.prometheusHost}/api/v1/query_range` +
      `?query=${encodeURIComponent(query)}` +
      `&start=${start.toISOString()}` +
      `&end=${end.toISOString()}` +
      `&step=${step}`;
    let response = await this.http.get(url).toPromise();
    let json = <PrometheusQueryResponse>response.json();
    if (json.status != "success") {
      throw new Error("Query failed!");
    }
    return json.data;
  }

  computeChartJsData(serieses: PrometheusSeries[], names: string[]=[]): ChartJsDataset {
    let chartData: ChartJsSeries[] = [];
    let labels = [];
    let index = 0;
    for (let series of serieses) {
      let chartSeriesData = [];
      for (let pair of series.values) {
        chartSeriesData.push(pair[1]);
        if (index == 0) {
          labels.push(new Date(pair[0] * 1000));
        }
      }
      chartData.push({
        data: chartSeriesData,
        label: names[index] || series.metric.__name__ || "!!unspecified!!",
        pointRadius: 0,
        pointHitRadius: 1,
      });
      index ++;
    }
    return {
      data: chartData,
      labels: labels,
    };
  }

  readonly bmax = 1e12;
  readonly lmax = 4103250;

  algoParams(date: Date): { tmax: number, t: number } {
    let somDate = new Date(date.getFullYear(), date.getMonth());
    let nsomDate = new Date(somDate);
    nsomDate.setMonth(nsomDate.getMonth() + 1);

    return {
      tmax: (nsomDate.getTime() - somDate.getTime()) / 1000,
      t: (date.getTime() - somDate.getTime()) / 1000,
    };
  }

  computeExpectedUsage(date: Date): number {
    let params = this.algoParams(date);
    let movedData = this.lmax * this.tgrace - this.bmax * this.tgrace / params.tmax;
    return params.t / params.tmax * (this.bmax - movedData) + movedData;
  }

  computeSpeedLimit(date: Date, usage: number): number {
    let params = this.algoParams(date);
    let m1l = (
      (this.bmax - this.lmax * this.tgrace
        + this.bmax * this.tgrace / params.tmax) *
      (params.t + this.tgrace) / params.tmax +
      this.lmax * this.tgrace - this.bmax * this.tgrace / params.tmax -
      usage
    ) / this.tgrace;
    let m2l = (this.bmax - usage) / (params.tmax - params.t);
    return min([max([m1l, m2l]), this.lmax]);
  }

  async onVisualize() {
    this.busy = true;
    this.usageData = null;
    this.speedData = null;
    try {
      let totalBytesSeries =
        (await this.queryPrometheus('l4_total_bytes', new Date(this.startDateString), new Date(this.endDateString), this.samplingInterval)).result;
      let speedSeries =
        (await this.queryPrometheus(`rate(l4_total_bytes[${this.samplingInterval}])`, new Date(this.startDateString), new Date(this.endDateString), this.samplingInterval)).result;

      let usageLimitPairs = [];
      for (let pair of totalBytesSeries[0].values) {
        usageLimitPairs.push([pair[0], this.computeExpectedUsage(new Date(pair[0]*1000))]);
      }
      totalBytesSeries.push({
        metric: {},
        values: usageLimitPairs,
      });

      let speedLimitPairs = [];
      for (let pair of totalBytesSeries[0].values) {
        speedLimitPairs.push([pair[0], this.computeSpeedLimit(new Date(pair[0]*1000), parseFloat(pair[1]))]);
      }
      speedSeries.push({
        metric: {},
        values: speedLimitPairs,
      });

      this.usageData = this.computeChartJsData(totalBytesSeries, ["Usage", "Usage Limit"]);
      this.speedData = this.computeChartJsData(speedSeries, ["Used Speed", "Speed Limit"]);
    } catch (exc) {
      alert(exc);
    } finally {
      this.busy = false;
    }
  }
}
