export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;

  constructor(status: number, title: string, detail: string, type = 'about:blank') {
    super(detail);
    this.status = status;
    this.title = title;
    this.type = type;
  }
}

export class ValidationError extends ProblemError {
  constructor(detail: string) {
    super(400, 'Validation Failed', detail);
  }
}

export class NotFoundError extends ProblemError {
  constructor(detail: string) {
    super(404, 'Not Found', detail);
  }
}

export class DependencyUnavailableError extends ProblemError {
  constructor(detail: string) {
    super(500, 'Dependency Unavailable', detail);
  }
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function toProblemResponse(
  error: unknown,
  instance: string,
  traceId: string,
): ProblemResponse {
  const problem =
    error instanceof ProblemError
      ? error
      : new ProblemError(500, 'Internal Server Error', 'An unexpected error occurred');
  return {
    statusCode: problem.status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail: problem.message,
      instance,
      traceId,
    }),
  };
}
