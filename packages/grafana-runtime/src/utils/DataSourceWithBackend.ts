import {
  DataSourceApi,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  DataQuery,
  DataSourceJsonData,
} from '@grafana/data';
import { Observable, from } from 'rxjs';
import { config } from '..';
import { getBackendSrv } from '../services';

// Ideally internal (exported for consistency)
const ExpressionDatasourceID = '__expr__';

export enum HealthStatus {
  Unknown = 'UNKNOWN',
  OK = 'OK',
  Error = 'ERROR',
}

export interface HealthCheckResult {
  status: HealthStatus;
  message: string;
  details?: Record<string, any>;
}

export class DataSourceWithBackend<
  TQuery extends DataQuery = DataQuery,
  TOptions extends DataSourceJsonData = DataSourceJsonData
> extends DataSourceApi<TQuery, TOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<TOptions>) {
    super(instanceSettings);
  }

  /**
   * Ideally final -- any other implementation may not work as expected
   */
  query(request: DataQueryRequest): Observable<DataQueryResponse> {
    const { targets, intervalMs, maxDataPoints, range, requestId } = request;
    let rangeFrom: any = undefined;
    let rangeTo: any = undefined;

    if (range) {
      rangeFrom = range.from.valueOf().toString();
      rangeTo = range.to.valueOf().toString();
    }

    let expressionCount = 0;
    const queries = targets.map(q => {
      if (q.datasource === ExpressionDatasourceID) {
        expressionCount++;
        return {
          datasourceId: this.id,
          datasourceName: q.datasource,
          refId: q.refId,
          from: rangeFrom,
          to: rangeTo,
          intervalMs,
          maxDataPoints,
          model: {
            ...q,
            datasourceId: this.id,
          },
        };
      }
      const dsName = q.datasource && q.datasource !== 'default' ? q.datasource : config.defaultDatasource;
      const ds = config.datasources[dsName];
      if (!ds) {
        throw new Error('Unknown Datasource: ' + q.datasource);
      }
      return {
        datasourceId: ds.id,
        datasourceName: q.datasource,
        refId: q.refId,
        from: rangeFrom,
        to: rangeTo,
        intervalMs,
        maxDataPoints,
        model: {
          ...this.applyTemplateVariables(q),
          datasourceId: ds.id,
        },
      };
    });

    const body: any = {
      queries,
    };

    const req: Promise<DataQueryResponse> = getBackendSrv()
      .datasourceRequest({
        url: expressionCount > 0 ? '/api/ds/transform' : '/api/ds/query',
        method: 'POST',
        data: body,
        requestId,
      })
      .then((rsp: any) => {
        return this.toDataQueryResponse(rsp?.data);
      });

    return from(req);
  }

  /**
   * Override to apply template variables
   */
  applyTemplateVariables(query: DataQuery) {
    return query;
  }

  /**
   * This makes the arrow library loading async.
   */
  async toDataQueryResponse(rsp: any): Promise<DataQueryResponse> {
    const { resultsToDataFrames } = await import(
      /* webpackChunkName: "apache-arrow-util" */ '@grafana/data/src/dataframe/ArrowDataFrame'
    );
    return { data: resultsToDataFrames(rsp) };
  }

  /**
   * Make a GET request to the datasource resource path
   */
  async getResource(path: string, params?: any): Promise<Record<string, any>> {
    return getBackendSrv().get(`/api/datasources/${this.id}/resources/${path}`, params);
  }

  /**
   * Send a POST request to the datasource resource path
   */
  async postResource(path: string, body?: any): Promise<Record<string, any>> {
    return getBackendSrv().post(`/api/datasources/${this.id}/resources/${path}`, { ...body });
  }

  /**
   * Run the datasource healthcheck
   */
  async callHealthCheck(): Promise<HealthCheckResult> {
    return getBackendSrv()
      .get(`/api/datasources/${this.id}/health`)
      .then(v => {
        return v as HealthCheckResult;
      })
      .catch(err => {
        err.isHandled = true; // Avoid extra popup warning
        return err.data as HealthCheckResult;
      });
  }

  /**
   * Checks the plugin health
   */
  async testDatasource(): Promise<any> {
    return this.callHealthCheck().then(res => {
      if (res.status === HealthStatus.OK) {
        return {
          status: 'success',
          message: res.message,
        };
      }
      return {
        status: 'fail',
        message: res.message,
      };
    });
  }
}
