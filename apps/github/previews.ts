import { belongsToRepository } from './canonical.js';
import { coversRepository } from './subscriptions.js';
import type {
  AppContext,
  Message,
  Subscription,
} from '../../src/core/types.js';
import type { GithubApi } from './api.js';
import { label, link, plain } from './notifications.js';

export async function previewLinks(
  context: AppContext,
  api: GithubApi,
  message: Message,
  subscriptions: Subscription[],
): Promise<void> {
  const urls = [
    ...new Set(
      message.content.match(/https:\/\/github\.com\/[^\s<>\])]+/g) ?? [],
    ),
  ].slice(0, 3);
  for (const raw of urls) {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, number] = parts;
    if (!owner) continue;
    const key = `${message.id}:${raw}`;
    if (context.store.get('github:previews', key)) continue;
    try {
      const client = await api.reader(message.author);
      let body: string;
      let privateRepo = false;
      const target = repo ? `${owner}/${repo}`.toLowerCase() : undefined;
      let subscription = subscriptions.find(
        (sub) =>
          sub.settings.previews !== false &&
          (sub.target === target ||
            (!sub.target.includes('/') && sub.target === owner.toLowerCase())),
      );
      if (!repo) {
        const result = await client.request('GET /users/{username}', {
          username: owner,
        });
        body = `[${label(result.data.name ?? result.data.login)}](${link(result.data.html_url)})${result.data.bio ? `\n${plain(result.data.bio, 400)}` : ''}`;
      } else {
        const repository = (
          await client.request('GET /repos/{owner}/{repo}', { owner, repo })
        ).data;
        if (!belongsToRepository(target!, repository)) continue;
        privateRepo = repository.private;
        if (
          subscription &&
          !coversRepository(subscription, repository.full_name, privateRepo)
        )
          subscription = undefined;
        if (kind === 'issues' || kind === 'pull') {
          if (!/^\d+$/.test(number ?? '')) continue;
          const issue = (
            await client.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}',
              { owner, repo, issue_number: Number(number) },
            )
          ).data;
          if (!belongsToRepository(target!, issue)) continue;
          body = `**${label(target)}**\n[#${issue.number}: ${label(issue.title)}](${link(issue.html_url)})\n**${label(issue.state)}**\n\n${plain(issue.body, 500)}`;
          const comment = /^#issuecomment-(\d+)$/.exec(url.hash);
          if (comment) {
            const result = await client.request(
              'GET /repos/{owner}/{repo}/issues/comments/{comment_id}',
              { owner, repo, comment_id: Number(comment[1]) },
            );
            if (!belongsToRepository(target!, result.data)) continue;
            body += `\n\n${label(result.data.user?.login)} commented:\n${plain(result.data.body, 500)}`;
          }
          const reviewComment = /^#discussion_r(\d+)$/.exec(url.hash);
          if (reviewComment) {
            const result = await client.request(
              'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}',
              { owner, repo, comment_id: Number(reviewComment[1]) },
            );
            if (!belongsToRepository(target!, result.data)) continue;
            body += `\n\n${label(result.data.user?.login)} commented:\n${plain(result.data.body, 500)}`;
          }
          const review = /^#pullrequestreview-(\d+)$/.exec(url.hash);
          if (review) {
            const result = await client.request(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}',
              {
                owner,
                repo,
                pull_number: Number(number),
                review_id: Number(review[1]),
              },
            );
            if (!belongsToRepository(target!, result.data)) continue;
            body += `\n\n${label(result.data.user?.login)}: ${label(result.data.state)}\n${plain(result.data.body, 500)}`;
          }
        } else if (kind === 'blob' && parts.length >= 5) {
          let path = parts.slice(4).join('/');
          let result;
          for (let split = 4; split < Math.min(parts.length, 12); split++) {
            path = parts.slice(split).join('/');
            try {
              result = await client.request(
                'GET /repos/{owner}/{repo}/contents/{path}',
                { owner, repo, path, ref: parts.slice(3, split).join('/') },
              );
              break;
            } catch (error) {
              if ((error as { status?: number }).status !== 404) throw error;
            }
          }
          if (!result) continue;
          if (
            Array.isArray(result.data) ||
            result.data.type !== 'file' ||
            !('content' in result.data) ||
            result.data.encoding !== 'base64'
          )
            continue;
          if (!belongsToRepository(target!, result.data)) continue;
          const content = Buffer.from(result.data.content, 'base64').toString(
            'utf8',
          );
          if (content.includes('\0')) continue;
          const selection = /^#L(\d+)(?:-L(\d+))?$/.exec(url.hash);
          const start = selection ? Number(selection[1]) : 1;
          const end = selection ? Number(selection[2] ?? selection[1]) : 12;
          const snippet = content
            .split('\n')
            .slice(start - 1, Math.min(end, start + 39))
            .join('\n')
            .slice(0, 3000)
            .replace(/```/g, '` ` `');
          body = `[${label(target)}/${label(path)}](${link(raw)})\n\n\`\`\`\n${snippet}\n\`\`\``;
        } else if (!kind)
          body = `[${label(repository.full_name)}](${link(repository.html_url)})${repository.description ? `\n${plain(repository.description, 500)}` : ''}`;
        else continue;
      }
      if (privateRepo && !subscription)
        await context.buzz.dm(message.author, body, {
          dedupKey: `github:preview:${key}`,
        });
      else if (
        !subscriptions.some(
          (sub) =>
            sub.settings.previews === false &&
            (sub.target === target || sub.target === owner.toLowerCase()),
        )
      )
        await context.buzz.send(message.channel, body, {
          root: message.root ?? message.id,
          dedupKey: `github:preview:${key}`,
        });
      context.store.set('github:previews', key, true);
    } catch (error) {
      // A pasted private link must not disclose either its existence or failure publicly.
      context.log.info(
        { status: (error as { status?: number }).status },
        'GitHub link preview unavailable',
      );
    }
  }
}
