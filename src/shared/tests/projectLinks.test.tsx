import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import AboutTab from '@/modules/settings/tabs/AboutTab';
import GitHubStarBadge from '@/modules/sidebar/GitHubStarBadge';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import {
  PROJECT_NEW_ISSUE_URL,
  PROJECT_REPO_URL,
  SHOW_UPDATE_PROMPT,
  SHOW_UPSTREAM_COMMUNITY_AND_HOSTED_LINKS,
  UPSTREAM_REPO_URL,
} from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

/**
 * [local] This build must not send its users to the original CloudCLI project
 * (siteboon/claudecodeui, cloudcli.ai, its Discord) for support. The only link
 * to the original project allowed is the attribution in Settings > About.
 */

const UPSTREAM_TARGET = /siteboon\/claudecodeui|cloudcli\.ai|discord\.gg/i;

const t = ((key: string) => key) as unknown as TFunction;

const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hrefsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('a')).map((anchor) => ({
    href: anchor.getAttribute('href') ?? '',
    role: anchor.getAttribute('data-link-role'),
  }));

const renderEverySurface = () => {
  const surfaces = [
    render(<AboutTab />),
    render(
      <SidebarFooter
        updateAvailable={false}
        restartRequired={false}
        releaseInfo={null}
        latestVersion={null}
        currentVersion="0.0.0-test"
        onShowVersionModal={() => {}}
        onShowSettings={() => {}}
        t={t}
      />,
    ),
    render(
      <SidebarCollapsed
        onExpand={() => {}}
        onShowSettings={() => {}}
        updateAvailable={false}
        restartRequired={false}
        onShowVersionModal={() => {}}
        t={t}
      />,
    ),
    render(
      <AuthScreenLayout title="Sign in" description="desc" footerText="footer">
        <div />
      </AuthScreenLayout>,
    ),
    render(<GitHubStarBadge />),
  ];
  return surfaces.flatMap(({ container }) => hrefsOf(container));
};

describe('project links', () => {
  test('the hide flags are off in this build', () => {
    expect(SHOW_UPSTREAM_COMMUNITY_AND_HOSTED_LINKS).toBe(false);
    expect(SHOW_UPDATE_PROMPT).toBe(false);
  });

  test('no rendered link targets the original project except the About attribution', () => {
    const links = renderEverySurface();

    const upstream = links.filter((link) => UPSTREAM_TARGET.test(link.href));
    expect(upstream).toEqual([{ href: UPSTREAM_REPO_URL, role: 'attribution' }]);
  });

  test('repository and issue links point to this build', () => {
    const hrefs = renderEverySurface().map((link) => link.href);

    expect(hrefs).toContain(PROJECT_REPO_URL);
    expect(hrefs).toContain(PROJECT_NEW_ISSUE_URL);
    expect(PROJECT_REPO_URL).toBe('https://github.com/Aztech-Lab/CloudCLI-MobileUI');
  });

  test('the About tab credits the original project by name and license', () => {
    const { container } = render(<AboutTab />);

    expect(container.textContent).toContain('Siteboon AI B.V.');
    expect(container.textContent).toContain('AGPL-3.0');
    expect(container.querySelector('a[data-link-role="attribution"]')?.textContent).toMatch(/credit/i);
  });

  test('the star badge asks GitHub about this build, not the original project', async () => {
    render(<GitHubStarBadge />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toContain('https://api.github.com/repos/Aztech-Lab/CloudCLI-MobileUI');
    expect(urls.some((url) => UPSTREAM_TARGET.test(url))).toBe(false);
  });

  test('the version check never asks GitHub for releases while the update prompt is off', async () => {
    const { result } = renderHook(() => useVersionCheck('Aztech-Lab', 'CloudCLI-MobileUI'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/health'));
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((url) => url.includes('api.github.com'))).toBe(false);
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.releaseInfo).toBeNull();
  });
});

describe('project link sources', () => {
  const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const CONSTANTS_FILE = path.join(SRC_DIR, 'shared', 'constants.ts');
  // URLs only: the visible label "cloudcli.ai" behind the hide flag is not a link target.
  const UPSTREAM_URL = /siteboon\/claudecodeui|https?:\/\/[^\s'"`]*cloudcli\.ai|discord\.gg/i;

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });

  test('original-project URLs are written only in the shared constants module', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => file !== CONSTANTS_FILE)
      .filter((file) => UPSTREAM_URL.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
