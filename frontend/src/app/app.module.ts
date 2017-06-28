import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpModule } from '@angular/http';
import {
  MdButtonModule,
  MdToolbarModule,
  MdInputModule,
  MdDatepickerModule,
  MdNativeDateModule,
  MdCardModule,
  MdProgressSpinnerModule,
} from '@angular/material';
import { ChartsModule } from 'ng2-charts/ng2-charts';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [
    AppComponent,
  ],
  imports: [
    BrowserModule,
    HttpModule,
    BrowserAnimationsModule,
    FormsModule,

    MdButtonModule,
    MdToolbarModule,
    MdInputModule,
    MdDatepickerModule,
    MdNativeDateModule,
    MdCardModule,
    MdProgressSpinnerModule,

    ChartsModule,
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
