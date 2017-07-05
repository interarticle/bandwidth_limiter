import { Component } from '@angular/core';
import { Http } from '@angular/http';
import { max, min, padStart, map, concat } from 'lodash';
import 'rxjs/add/operator/toPromise';

interface PrometheusSeries {
  values: any[];
  metric: {
    __name__?: string;
    since?: string;
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
  data: {x: number, y: number}[];
  label: string;
  pointRadius?: number;
  pointHitRadius?: number;
}

interface ChartJsDataset {
  data: ChartJsSeries[];
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
  // Number of bytes to move from the end of the month to the beginning of the
  // month, in addition to those implied by tgrace.
  bMovedEarly = 0;

  constructor (private http: Http) {
    this.endDateString = this.toISODate(new Date());
    this.startDateString = this.toISODate(
      new Date((new Date()).getTime() - 30*24*60*60*1000));

    this.usageChartOptions = {
      scales: {
        xAxes: [{
          type: 'linear',
          ticks: {
            callback: millis => {
              var dt = new Date(millis);
              return `${dt.getMonth()+1}/${dt.getDate()}`;
            },
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
          title: items => new Date(items[0].xLabel).toString(),
          label: item => this.formatBytes(item.yLabel),
        },
      },
    };
    this.speedChartOptions = {
      scales: {
        xAxes: [{
          type: 'linear',
          ticks: {
            callback: millis => {
              var dt = new Date(millis);
              return `${dt.getMonth()+1}/${dt.getDate()}`;
            },
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
          title: items => new Date(items[0].xLabel).toString(),
          label: item => this.formatBytes(item.yLabel) + '/s',
        },
      },
    };
  }

  private toISODate(datetime: Date): string {
    return datetime.getFullYear() + '-' +
      padStart((datetime.getMonth() + 1).toString(), 2, '0') + '-' +
      padStart(datetime.getDate().toString(), 2, '0');
  }

  private readonly units: string[] = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'EiB'];
  private formatBytes(bytes: number): string {
    let unit: string;
    for (unit of this.units) {
      if (bytes < 1000) {
        break;
      }
      bytes /= 1024;
    }
    return `${bytes.toFixed(2)} ${unit}`;
  }

  private async queryPrometheus(query: string, start: Date, end: Date, step: string = "1m"): Promise<PrometheusResponseData> {
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

  private computeChartJsData(serieses: PrometheusSeries[], names: string[]=[]): ChartJsDataset {
    let chartData: ChartJsSeries[] = [];
    let index = 0;
    for (let series of serieses) {
      let chartSeriesData = [];
      for (let pair of series.values) {
        chartSeriesData.push({x: pair[0] * 1000, y: pair[1]});
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
    };
  }

  private readonly bmax = 1e12;
  private readonly lmax = 4103250;

  private algoParams(date: Date): { tmax: number, t: number } {
    let somDate = new Date(date.getFullYear(), date.getMonth());
    let nsomDate = new Date(somDate);
    nsomDate.setMonth(nsomDate.getMonth() + 1);

    return {
      tmax: (nsomDate.getTime() - somDate.getTime()) / 1000,
      t: (date.getTime() - somDate.getTime()) / 1000,
    };
  }

  private computeExpectedUsage(date: Date): number {
    let params = this.algoParams(date);
    let movedData = this.lmax * this.tgrace - this.bmax * this.tgrace / params.tmax + this.bMovedEarly;
    return params.t / params.tmax * (this.bmax - movedData) + movedData;
  }

  private computeSpeedLimit(date: Date, usage: number): number {
    let params = this.algoParams(date);
    let m1l = (
      (this.bmax - this.lmax * this.tgrace
        + this.bmax * this.tgrace / params.tmax - this.bMovedEarly)
      * (params.t + this.tgrace) / params.tmax
      + this.lmax * this.tgrace - this.bmax * this.tgrace / params.tmax
      + this.bMovedEarly
      - usage
    ) / this.tgrace;
    let m2l = (this.bmax - usage) / (params.tmax - params.t);
    return min([max([m1l, m2l]), this.lmax]);
  }

  // Removes data in serieses that do not match their "since" label,
  // interpreted as the month during which the series is valid for.
  private filterSeriesBySince(serieses: PrometheusSeries[]): PrometheusSeries[] {
    let outSerieses: PrometheusSeries[] = [];
    for (let series of serieses) {
      let year = parseInt(series.metric.since.substring(0, 4));
      let month = parseInt(series.metric.since.substring(5, 7));
      let startTimestamp = (new Date(year, month - 1)).getTime() / 1000;
      let endTimestamp = (new Date(year, month)).getTime() / 1000;
      let outValues: any[] = [];
      for (let value of series.values) {
        if (!(value[0] >= startTimestamp && value[0] < endTimestamp)) continue;
        outValues.push(value);
      }
      outSerieses.push({
        metric: series.metric,
        values: outValues,
      });
    }
    return outSerieses;
  }

  async onVisualize() {
    this.busy = true;
    this.usageData = null;
    this.speedData = null;
    try {
      let totalBytesSeries =
        (await this.queryPrometheus('l4_total_bytes', new Date(this.startDateString), new Date(this.endDateString), this.samplingInterval)).result;
      totalBytesSeries = this.filterSeriesBySince(totalBytesSeries);
      let speedSeries =
        (await this.queryPrometheus(`rate(l4_total_bytes[${this.samplingInterval}])`, new Date(this.startDateString), new Date(this.endDateString), this.samplingInterval)).result;
      speedSeries = this.filterSeriesBySince(speedSeries);

      let numSeries = totalBytesSeries.length;
      let seriesMonths = map(totalBytesSeries, series => series.metric.since);

      for (let i = 0; i < numSeries; i++) {
        let usageLimitPairs = [];
        for (let pair of totalBytesSeries[i].values) {
          usageLimitPairs.push([pair[0], this.computeExpectedUsage(new Date(pair[0]*1000))]);
        }
        totalBytesSeries.push({
          metric: {},
          values: usageLimitPairs,
        });
      }


      for (let i = 0; i < numSeries; i++) {
        let speedLimitPairs = [];
        for (let pair of totalBytesSeries[i].values) {
          speedLimitPairs.push([pair[0], this.computeSpeedLimit(new Date(pair[0]*1000), parseFloat(pair[1]))]);
        }
        speedSeries.push({
          metric: {},
          values: speedLimitPairs,
        });
      }

      this.usageData = this.computeChartJsData(
        totalBytesSeries,
        concat(map(seriesMonths, month => `${month} Usage`),
          map(seriesMonths, month => `${month} Usage Limit`)));
      this.speedData = this.computeChartJsData(
        speedSeries,
        concat(map(seriesMonths, month => `${month} Speed`),
          map(seriesMonths, month => `${month} Speed Limit`)));
    } catch (exc) {
      alert(exc);
    } finally {
      this.busy = false;
    }
  }
}
