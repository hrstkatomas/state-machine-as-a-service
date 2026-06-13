export interface ApiOptions {
  api: string;
  key?: string;
}

export class ApiClient {
  constructor(private readonly opts: ApiOptions) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.opts.api), {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.opts.key && { authorization: `Bearer ${this.opts.key}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${path} → ${response.status}: ${detail}`);
    }
    return response.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
