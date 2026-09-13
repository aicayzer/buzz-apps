import { GithubInputError } from './errors.js';
import picomatch from 'picomatch';
import type { Subscription } from '../../src/core/types.js';

export const DEFAULT_FEATURES = [
  'issues',
  'pulls',
  'commits',
  'releases',
  'deployments',
];
export const FEATURES = [
  ...DEFAULT_FEATURES,
  'workflows',
  'reviews',
  'comments',
  'branches',
  'discussions',
];
export type Filters = {
  branches?: string[];
  label?: string;
  workflow?: string[];
  event?: string[];
  actor?: string[];
};
export const subscriptionKey = (channel: string, target: string) =>
  `${channel}:${target.toLowerCase()}`;
export function targetParts(target: string): { owner: string; repo?: string } {
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d_.-]+)?$/i.test(target))
    throw new GithubInputError('Use OWNER or OWNER/REPO.');
  const [owner, repo] = target.split('/');
  return { owner, repo };
}
export function parseFeatures(tokens: string[]): {
  features: string[];
  filters: Filters;
} {
  const features: string[] = [];
  const filters: Filters = {};
  for (const token of tokens) {
    if (token.startsWith('workflows:{') && token.endsWith('}')) {
      features.push('workflows');
      const inner = token.slice(11, -1);
      const parts = [
        ...inner.matchAll(
          /(?:^|,)\s*(name|event|branch|actor)\s*:\s*(.*?)(?=,\s*(?:name|event|branch|actor)\s*:|$)/g,
        ),
      ];
      if (!parts.length)
        throw new GithubInputError(
          'Workflow filters use workflows:{name:CI,event:push,branch:main,actor:LOGIN}.',
        );
      for (const match of parts) {
        const key = {
          name: 'workflow',
          event: 'event',
          branch: 'branches',
          actor: 'actor',
        }[match[1]] as keyof Filters;
        (filters as Record<string, unknown>)[key] = match[2]
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      }
      continue;
    }
    if (FEATURES.includes(token)) {
      features.push(token);
      continue;
    }
    if (token.startsWith('commits:')) {
      features.push('commits');
      filters.branches = token.slice(8).split(',');
      continue;
    }
    if (token.startsWith('+label:')) {
      filters.label = token.slice(7);
      if (!filters.label)
        throw new GithubInputError('Provide a label after +label:.');
      continue;
    }
    const match =
      /^(?:workflows:)?(name|workflow|event|branch|actor)=(.+)$/.exec(token);
    if (match) {
      const key = {
        name: 'workflow',
        workflow: 'workflow',
        event: 'event',
        branch: 'branches',
        actor: 'actor',
      }[match[1]] as keyof Filters;
      (filters as Record<string, unknown>)[key] = match[2].split(',');
      continue;
    }
    throw new GithubInputError(
      `Unknown feature or filter: ${token}. Features: ${FEATURES.join(', ')}. Filters: commits:BRANCH, +label:LABEL, name=WORKFLOW, event=EVENT, branch=BRANCH, actor=LOGIN.`,
    );
  }
  return { features: [...new Set(features)], filters };
}
export function coversRepository(
  subscription: Subscription,
  fullName: string,
  isPrivate: boolean,
): boolean {
  const repo = fullName.toLowerCase();
  const target = subscription.target.toLowerCase();
  if (repo === target) return true;
  if (target.includes('/') || !repo.startsWith(`${target}/`)) return false;
  if (!isPrivate) return true;
  return (
    Array.isArray(subscription.settings.approvedRepositories) &&
    subscription.settings.approvedRepositories.includes(repo)
  );
}
export function matchesSubscription(
  subscription: Subscription,
  event: string,
  payload: any,
): boolean {
  const repo = String(payload.repository?.full_name ?? '').toLowerCase();
  if (
    !coversRepository(subscription, repo, payload.repository?.private === true)
  )
    return false;
  const feature = (
    {
      issues: 'issues',
      pull_request: 'pulls',
      push: 'commits',
      release: 'releases',
      deployment: 'deployments',
      deployment_status: 'deployments',
      workflow_run: 'workflows',
      pull_request_review: 'reviews',
      pull_request_review_comment: 'comments',
      issue_comment: 'comments',
      create: 'branches',
      delete: 'branches',
      discussion: 'discussions',
      discussion_comment: 'discussions',
    } as Record<string, string>
  )[event];
  if (!feature || !subscription.features.includes(feature)) return false;
  if (
    (event === 'create' || event === 'delete') &&
    payload.ref_type !== 'branch'
  )
    return false;
  if (
    event === 'release' &&
    !['published', 'released'].includes(payload.action)
  )
    return false;
  const filters = (subscription.settings.filters ?? {}) as Filters;
  const item = payload.pull_request ?? payload.issue ?? payload.discussion;
  if (
    filters.label &&
    item &&
    !item.labels?.some((label: any) => label.name === filters.label)
  )
    return false;
  if (event === 'push') {
    if (!String(payload.ref).startsWith('refs/heads/') || payload.deleted)
      return false;
    const branch = String(payload.ref).replace('refs/heads/', '');
    const branches = filters.branches ?? [
      String(payload.repository?.default_branch ?? 'main'),
    ];
    if (!branches.some((pattern) => picomatch.isMatch(branch, pattern)))
      return false;
  }
  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    if (!run) return false;
    if (
      filters.branches &&
      !filters.branches.some((pattern) =>
        picomatch.isMatch(run.head_branch ?? '', pattern),
      )
    )
      return false;
    if (
      filters.workflow &&
      !filters.workflow.some((name) => picomatch.isMatch(run.name ?? '', name))
    )
      return false;
    if (filters.event && !filters.event.includes(run.event)) return false;
    if (filters.actor && !filters.actor.includes(run.actor?.login))
      return false;
    if (
      !filters.branches &&
      !filters.workflow &&
      !filters.event &&
      !filters.actor
    ) {
      if (
        run.event !== 'pull_request' ||
        !run.pull_requests?.some(
          (pr: any) => pr.base?.ref === payload.repository?.default_branch,
        )
      )
        return false;
    }
  }
  return true;
}
