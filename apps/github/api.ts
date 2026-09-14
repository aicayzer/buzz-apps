import { GithubInputError } from './errors.js';
import { App, Octokit } from 'octokit';
import type { AppContext, Account } from '../../src/core/types.js';
import { targetParts } from './subscriptions.js';

export class GithubApi {
  private application?: App;
  constructor(private readonly context: AppContext) {}
  async account(pubkey: string): Promise<Account> {
    const account = this.context.account
      ? await this.context.account(pubkey)
      : this.context.store.account(pubkey);
    if (!account)
      throw new GithubInputError('Sign in first with @GitHub signin.');
    return account;
  }
  async user(pubkey: string): Promise<Octokit> {
    return new Octokit({
      auth: (await this.account(pubkey)).token,
      retry: { enabled: false },
      throttle: { enabled: false },
    });
  }
  async contributions(pubkey: string): Promise<Octokit> {
    const account = await this.account(pubkey);
    const token = this.context.config.githubContributionTokens?.[pubkey];
    if (!token) return this.user(pubkey);
    const client = new Octokit({
      auth: token,
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const identity = (await client.request('GET /user')).data;
    if (identity.login.toLowerCase() !== account.login.toLowerCase())
      throw new GithubInputError(
        'The contribution credential belongs to a different GitHub account.',
      );
    return client;
  }
  async reader(pubkey: string): Promise<Octokit> {
    const account = this.context.account
      ? await this.context.account(pubkey)
      : this.context.store.account(pubkey);
    return new Octokit({
      auth: account?.token,
      retry: { enabled: false },
      throttle: { enabled: false },
    });
  }
  async installationId(owner: string, repo?: string): Promise<number> {
    const config = this.context.config.github;
    if (!config)
      throw new GithubInputError(
        'The GitHub app has not been configured. Run buzz-apps enable github.',
      );
    this.application ??= new App({
      appId: config.appId,
      privateKey: config.privateKey,
    });
    let id: number;
    if (repo)
      id = (
        await this.application.octokit.request(
          'GET /repos/{owner}/{repo}/installation',
          { owner, repo },
        )
      ).data.id;
    else {
      try {
        id = (
          await this.application.octokit.request(
            'GET /orgs/{org}/installation',
            { org: owner },
          )
        ).data.id;
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        id = (
          await this.application.octokit.request(
            'GET /users/{username}/installation',
            { username: owner },
          )
        ).data.id;
      }
    }
    return id;
  }
  async installation(owner: string, repo?: string): Promise<Octokit> {
    const id = await this.installationId(owner, repo);
    return (await this.application!.getInstallationOctokit(
      id,
    )) as unknown as Octokit;
  }
  async approvedRepositories(pubkey: string, owner: string): Promise<string[]> {
    const installation_id = await this.installationId(owner);
    const client = await this.user(pubkey);
    const repositories = await client.paginate(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id, per_page: 100 },
    );
    return repositories.map((repo) => repo.full_name.toLowerCase());
  }
  async authorised(pubkey: string, target: string): Promise<Octokit> {
    const parts = targetParts(target);
    const client = await this.user(pubkey);
    if (parts.repo)
      await client.request('GET /repos/{owner}/{repo}', {
        owner: parts.owner,
        repo: parts.repo,
      });
    else {
      const account = await this.account(pubkey);
      if (account.login.toLowerCase() !== parts.owner.toLowerCase()) {
        const membership = await client.request(
          'GET /user/memberships/orgs/{org}',
          { org: parts.owner },
        );
        if (membership.data.state !== 'active')
          throw new GithubInputError(
            'You need active membership of that organisation.',
          );
      }
    }
    await this.installation(parts.owner, parts.repo);
    return client;
  }
}

export function friendlyError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401) return 'GitHub sign-in has expired. Use @GitHub signin.';
  if (status === 403)
    return 'GitHub refused this request. Check your access, app permissions and any organisation approval requirements.';
  if (status === 404)
    return 'GitHub could not find this resource with the available access. Check its name and the GitHub App installation.';
  if (status === 422)
    return 'GitHub could not accept these values. Check the resource state and the supplied fields.';
  if (status === 429)
    return 'GitHub is rate limiting requests. Please try again later.';
  if (status && status >= 500)
    return 'GitHub is temporarily unavailable. Please try again later.';
  return error instanceof Error && !status
    ? error.message
    : 'The GitHub request failed. Check the service logs.';
}
