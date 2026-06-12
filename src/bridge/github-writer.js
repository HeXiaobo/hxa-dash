class GitHubWriter {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || global.fetch;
    this.env = options.env || process.env;
  }

  async createIssue({ title, body, labels = [] }) {
    return this.request(`/repos/${this.repoPath()}/issues`, {
      method: 'POST',
      body: { title, body, labels },
    });
  }

  async createComment(issueNumber, body) {
    return this.request(`/repos/${this.repoPath()}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: { body },
    });
  }

  repoPath() {
    return `${this.config.github.owner}/${this.config.github.repo}`;
  }

  async request(pathname, { method, body }) {
    if (this.config.dry_run) {
      return {
        dry_run: true,
        url: `https://github.com/${this.repoPath()}`,
        number: body.title ? 0 : undefined,
        id: body.title ? undefined : 0,
      };
    }

    if (!this.fetch) throw new Error('fetch is not available in this Node runtime');
    const tokenName = this.config.github.token_env || 'HXA_BRIDGE_GITHUB_TOKEN';
    const token = this.env[tokenName];
    if (!token) throw new Error(`${tokenName} is not configured`);

    const response = await this.fetch(`${this.config.github.api_base || 'https://api.github.com'}${pathname}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${data.message || response.statusText}`);
    }
    return data;
  }
}

module.exports = {
  GitHubWriter,
};
