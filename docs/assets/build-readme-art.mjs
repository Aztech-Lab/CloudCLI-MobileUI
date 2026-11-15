// [local] Generates the README artwork (light + dark SVGs) and the GitHub social preview.
//
//   node docs/assets/build-readme-art.mjs            # SVGs + social-preview.png
//   node docs/assets/build-readme-art.mjs --png DIR  # also rasterise every SVG into DIR (for review)
//
// Colours follow the OTSR skin (src/skins/otsr.css). Fonts are system stacks because
// GitHub serves README images without web fonts. Animations are CSS, so they stop
// under prefers-reduced-motion.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

const PALETTES = {
  light: {
    bg: '#ebebe8', panel: '#f4f4f1', ink: '#111312', text: '#24261f', muted: '#6f726a',
    line: '#c7c8c0', copper: '#b8793c', copperSoft: '#e8d3b6', dot: 'rgba(20,22,20,0.11)',
    frame: '#1d201e', screen: '#161919', screenText: '#e2e3dc', screenMuted: '#9ba09a', ok: '#4f7a4a',
  },
  dark: {
    bg: '#0f1112', panel: '#161919', ink: '#f1f1ea', text: '#e2e3dc', muted: '#9ba09a',
    line: '#2b302f', copper: '#d9a25f', copperSoft: '#3a3226', dot: 'rgba(232,232,226,0.07)',
    frame: '#2b302f', screen: '#0b0c0d', screenText: '#e2e3dc', screenMuted: '#9ba09a', ok: '#8fbf7a',
  },
};

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** OTSR chamfer: top-right and bottom-left corners cut. */
function chamfer(x, y, w, h, c) {
  return [[x, y], [x + w - c, y], [x + w, y + c], [x + w, y + h], [x + c, y + h], [x, y + h - c]]
    .map(([px, py]) => `${px},${py}`).join(' ');
}

function styles(p) {
  return `
  .sans { font-family: ${SANS}; }
  .mono { font-family: ${MONO}; }
  .flow { stroke-dasharray: 4 7; animation: flow 1.4s linear infinite; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; }
  .pulse2 { animation: pulse 1.6s ease-in-out .8s infinite; }
  .cursor { animation: blink 1.1s steps(1) infinite; }
  .swipe { animation: swipe 9s ease-in-out infinite; }
  @keyframes flow { to { stroke-dashoffset: -22; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  @keyframes swipe {
    0%, 18% { transform: translateX(0); }
    25%, 43% { transform: translateX(43.5px); }
    50%, 68% { transform: translateX(83px); }
    75%, 93% { transform: translateX(121.5px); }
    100% { transform: translateX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .flow, .pulse, .pulse2, .cursor, .swipe { animation: none; }
  }`;
}

function backdrop(p, W, H) {
  return `
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="11" cy="11" r="1.1" fill="${p.dot}"/>
    </pattern>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${p.muted}"/>
    </marker>
  </defs>
  <rect width="${W}" height="${H}" fill="${p.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  <polygon points="${chamfer(20, 20, W - 40, H - 40, 18)}" fill="none" stroke="${p.line}"/>`;
}

function phone(p, x, y) {
  // 200 x 400 handset; screen content drawn in the skin's colours.
  const sx = x + 10, sy = y + 10;
  return `
  <g fill="${p.text}">
  <rect x="${x}" y="${y}" width="200" height="400" rx="30" fill="${p.frame}"/>
  <rect x="${sx}" y="${sy}" width="180" height="380" rx="22" fill="${p.panel}"/>
  <rect x="${x + 70}" y="${y + 18}" width="60" height="12" rx="6" fill="${p.frame}"/>
  <g class="mono" font-size="9" letter-spacing="1" font-weight="600">
    <text x="${x + 22}" y="${y + 52}" fill="${p.muted}">CHAT</text>
    <text x="${x + 62}" y="${y + 52}" fill="${p.muted}">FILES</text>
    <text x="${x + 108}" y="${y + 52}" fill="${p.muted}">GIT</text>
    <text x="${x + 140}" y="${y + 52}" fill="${p.muted}">SHELL</text>
  </g>
  <g class="swipe"><rect x="${x + 24}" y="${y + 58}" width="22" height="2" fill="${p.copper}"/></g>
  <line x1="${x + 18}" y1="${y + 66}" x2="${x + 182}" y2="${y + 66}" stroke="${p.line}"/>
  <polygon points="${chamfer(x + 62, y + 78, 116, 34, 6)}" fill="${p.copperSoft}"/>
  <g class="sans" font-size="10">
    <text x="${x + 70}" y="${y + 93}">Run the test suite</text>
    <text x="${x + 70}" y="${y + 106}">and fix what fails</text>
  </g>
  <rect x="${x + 22}" y="${y + 124}" width="150" height="6" rx="3" fill="${p.line}"/>
  <rect x="${x + 22}" y="${y + 136}" width="128" height="6" rx="3" fill="${p.line}"/>
  <rect x="${x + 22}" y="${y + 148}" width="96" height="6" rx="3" fill="${p.line}"/>
  <polygon points="${chamfer(x + 22, y + 164, 156, 48, 6)}" fill="${p.bg}" stroke="${p.copper}"/>
  <rect class="pulse" x="${x + 32}" y="${y + 176}" width="8" height="8" fill="${p.copper}"/>
  <text class="mono" x="${x + 46}" y="${y + 183}" font-size="8.5" letter-spacing=".8" fill="${p.copper}">SUBAGENT · RUNNING</text>
  <text class="sans" x="${x + 32}" y="${y + 202}" font-size="10">literature search</text>
  <rect x="${x + 22}" y="${y + 226}" width="146" height="6" rx="3" fill="${p.line}"/>
  <rect x="${x + 22}" y="${y + 238}" width="118" height="6" rx="3" fill="${p.line}"/>
  <polygon points="${chamfer(x + 22, y + 258, 156, 30, 6)}" fill="${p.bg}" stroke="${p.line}"/>
  <rect x="${x + 32}" y="${y + 269}" width="8" height="8" fill="${p.ok}"/>
  <text class="mono" x="${x + 46}" y="${y + 276.5}" font-size="8.5" letter-spacing=".8" fill="${p.ok}">TESTS · 24 PASSED</text>
  <rect x="${x + 22}" y="${y + 302}" width="140" height="6" rx="3" fill="${p.line}"/>
  <rect x="${x + 22}" y="${y + 314}" width="100" height="6" rx="3" fill="${p.line}"/>
  <polygon points="${chamfer(x + 22, y + 342, 156, 32, 6)}" fill="${p.bg}" stroke="${p.line}"/>
  <text class="sans" x="${x + 32}" y="${y + 362}" font-size="10" fill="${p.muted}">Message</text>
  <rect x="${x + 154}" y="${y + 350}" width="16" height="16" fill="${p.copper}"/>
  </g>`;
}

function workstation(p, x, y) {
  // 300 x 196 monitor with a terminal showing the main thread and two agents.
  const tx = x + 32;
  const row = (dy, cls, name, task) => `
    <rect class="${cls}" x="${tx}" y="${y + dy - 8}" width="8" height="8" fill="${cls ? p.copper : p.ok}"/>
    <text x="${tx + 14}" y="${y + dy}" fill="${p.screenText}">${name}</text>
    <text x="${tx + 98}" y="${y + dy}" fill="${p.screenMuted}">${task}</text>`;
  return `
  <polygon points="${chamfer(x, y, 300, 196, 12)}" fill="${p.panel}" stroke="${p.line}"/>
  <rect x="${x + 14}" y="${y + 14}" width="272" height="150" fill="${p.screen}"/>
  <g class="mono" font-size="12.5">
    <text x="${tx}" y="${y + 40}" fill="${p.screenText}"><tspan fill="${p.copper}">$</tspan> claude</text>
    ${row(70, '', 'main', 'talking to phone')}
    ${row(94, 'pulse', 'agent 1', 'literature search')}
    ${row(118, 'pulse2', 'agent 2', 'test suite')}
    <text x="${tx}" y="${y + 146}" fill="${p.copper}">$</text>
    <rect class="cursor" x="${tx + 12}" y="${y + 136}" width="8" height="13" fill="${p.screenText}"/>
  </g>
  <rect x="${x + 130}" y="${y + 196}" width="40" height="22" fill="${p.line}"/>
  <rect x="${x + 90}" y="${y + 218}" width="120" height="7" rx="3.5" fill="${p.line}"/>`;
}

function hero(p, { W = 1280, H = 560, dy = 0 } = {}) {
  const chip = (x, w, label) => `
    <polygon points="${chamfer(x, 372 + dy, w, 34, 7)}" fill="${p.panel}" stroke="${p.line}"/>
    <text class="mono" x="${x + w / 2}" y="${394 + dy}" font-size="12.5" letter-spacing="1.4" text-anchor="middle" fill="${p.text}">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" fill="${p.text}">
  <title id="t">CloudCLI-MobileUI</title>
  <desc id="d">A workstation running Claude Code with two background agents, connected over LAN or VPN to a phone showing the conversation.</desc>
  <style>${styles(p)}</style>
  ${backdrop(p, W, H)}
  <text class="mono" x="72" y="${168 + dy}" font-size="13.5" letter-spacing="2.6" fill="${p.copper}">SELF-HOSTED · MOBILE-FIRST · OPEN SOURCE</text>
  <text class="sans" x="70" y="${236 + dy}" font-size="58" font-weight="700" letter-spacing="-1" fill="${p.ink}">CloudCLI-MobileUI</text>
  <text class="sans" x="72" y="${290 + dy}" font-size="23">Run Claude Code on your own computer.</text>
  <text class="sans" x="72" y="${324 + dy}" font-size="23">Keep working with it from your phone.</text>
  ${chip(72, 128, 'SWIPE TABS')}
  ${chip(212, 196, 'BACKGROUND AGENTS')}
  ${chip(420, 84, 'SKINS')}
  <text class="mono" x="72" y="${466 + dy}" font-size="11.5" letter-spacing="1.6" fill="${p.muted}">BUILT ON CLOUDCLI · AGPL-3.0</text>
  ${workstation(p, 680, 170 + dy)}
  <text class="mono" x="830" y="${430 + dy}" font-size="11" letter-spacing="1.8" text-anchor="middle" fill="${p.muted}">YOUR WORKSTATION</text>
  <path class="flow" d="M 900 ${168 + dy} C 930 ${70 + dy}, 1030 ${62 + dy}, 1080 ${118 + dy}" fill="none" stroke="${p.copper}" stroke-width="2"/>
  <text class="mono" x="985" y="${72 + dy}" font-size="11" letter-spacing="1.8" text-anchor="middle" fill="${p.copper}">LAN · VPN</text>
  ${phone(p, 1030, 120 + dy)}
</svg>
`;
}

function icon(p, kind, x, y) {
  const s = `fill="none" stroke="${p.ink}" stroke-width="1.6"`;
  switch (kind) {
    case 'phone': return `<rect x="${x + 6}" y="${y}" width="16" height="28" rx="3" ${s}/><line x1="${x + 11}" y1="${y + 24}" x2="${x + 17}" y2="${y + 24}" ${s}/>`;
    case 'server': return [0, 10, 20].map((d) => `<rect x="${x}" y="${y + d}" width="28" height="8" ${s}/><rect x="${x + 22}" y="${y + d + 3}" width="2" height="2" fill="${p.copper}"/>`).join('');
    case 'cli': return `<rect x="${x}" y="${y + 2}" width="28" height="24" ${s}/><text class="mono" x="${x + 4}" y="${y + 19}" font-size="11" fill="${p.copper}">&gt;_</text>`;
    case 'files': return `<path d="M${x} ${y + 4} h10 l3 4 h15 v18 h-28 z" ${s}/>`;
    default: return '';
  }
}

function howItWorks(p, { W = 1280, H = 440 } = {}) {
  const boxes = [
    { x: 60, icon: 'phone', title: 'Your phone', lines: ['Any browser, or', 'the home-screen app'] },
    { x: 380, icon: 'server', title: 'CloudCLI-MobileUI', lines: ['Runs on your', 'workstation (Node.js)'], hi: true },
    { x: 700, icon: 'cli', title: 'Claude Code', lines: ['Same CLI, same login,', 'same sessions'] },
    { x: 1020, icon: 'files', title: 'Your project', lines: ['Files, git and', 'the terminal'] },
  ];
  const Y = 100, BW = 210, BH = 150;
  const box = (b) => `
    <polygon points="${chamfer(b.x, Y, BW, BH, 12)}" fill="${p.panel}" stroke="${b.hi ? p.copper : p.line}" stroke-width="${b.hi ? 1.6 : 1}"/>
    ${icon(p, b.icon, b.x + 20, Y + 22)}
    <text class="sans" x="${b.x + 20}" y="${Y + 84}" font-size="${b.title.length > 14 ? 16.5 : 19}" font-weight="700" fill="${p.ink}">${b.title}</text>
    <text class="sans" x="${b.x + 20}" y="${Y + 108}" font-size="13" fill="${p.muted}">${b.lines[0]}</text>
    <text class="sans" x="${b.x + 20}" y="${Y + 126}" font-size="13" fill="${p.muted}">${b.lines[1]}</text>`;
  const link = (from, label, both) => {
    const x1 = from.x + BW + 6, x2 = from.x + BW + 110 - 6, y = Y + 75;
    return `
    <line class="flow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${p.muted}" stroke-width="1.6" ${both ? 'marker-start="url(#arrow)"' : ''} marker-end="url(#arrow)"/>
    <text class="mono" x="${(x1 + x2) / 2}" y="${y - 12}" font-size="10.5" letter-spacing="1.2" text-anchor="middle" fill="${p.muted}">${label}</text>`;
  };
  const agent = (y, label, cls) => `
    <polygon points="${chamfer(700, y, 210, 30, 6)}" fill="${cls ? p.bg : p.copperSoft}" stroke="${cls ? p.copper : 'none'}"/>
    <rect class="${cls}" x="712" y="${y + 11}" width="8" height="8" fill="${cls ? p.copper : p.ok}"/>
    <text class="mono" x="728" y="${y + 19.5}" font-size="10.5" letter-spacing="1" fill="${cls ? p.copper : p.text}">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" fill="${p.text}">
  <title id="t">How CloudCLI-MobileUI works</title>
  <desc id="d">Your phone talks to the CloudCLI-MobileUI server on your workstation over your own network; the server runs Claude Code, which works on your project. Background agents keep running while you chat.</desc>
  <style>${styles(p)}</style>
  ${backdrop(p, W, H)}
  <text class="mono" x="60" y="66" font-size="13" letter-spacing="2.6" fill="${p.copper}">HOW IT WORKS</text>
  ${boxes.map(box).join('')}
  ${link(boxes[0], 'LAN · VPN', true)}
  ${link(boxes[1], 'STREAMS', true)}
  ${link(boxes[2], 'READS · EDITS', false)}
  <line x1="805" y1="${Y + BH}" x2="805" y2="280" stroke="${p.line}"/>
  ${agent(280, 'MAIN THREAD · CHATTING', '')}
  ${agent(318, 'SUBAGENT · RUNNING', 'pulse')}
  ${agent(356, 'SUBAGENT · RUNNING', 'pulse2')}
  <g class="sans" font-size="15">
    <text x="60" y="304">Your phone reaches the workstation over your own network.</text>
    <text x="60" y="328">Claude Code, your files and your login stay on the workstation.</text>
  </g>
  <text class="mono" x="60" y="372" font-size="11" letter-spacing="1.4" fill="${p.copper}">IN TESTING · BACKGROUND AGENTS KEEP RUNNING WHILE YOU CHAT  →</text>
</svg>
`;
}

function skins(p, { W = 1280, H = 520 } = {}) {
  // The same screen in both OTSR palettes, then an open slot for the next skin.
  const Y = 56;
  const outline = (x) => `
  <rect x="${x - 0.5}" y="${Y - 0.5}" width="201" height="401" rx="30.5" fill="none" stroke="${p.line}"/>`;
  const label = (x, text, fill) => `
  <text class="mono" x="${x + 100}" y="${Y + 432}" font-size="11" letter-spacing="1.8" text-anchor="middle" fill="${fill}">${text}</text>`;
  const slot = (x) => `
  <rect class="flow" x="${x}" y="${Y}" width="200" height="400" rx="30" fill="none" stroke="${p.copper}" stroke-width="1.6"/>
  <line x1="${x + 100}" y1="${Y + 150}" x2="${x + 100}" y2="${Y + 190}" stroke="${p.copper}" stroke-width="2"/>
  <line x1="${x + 80}" y1="${Y + 170}" x2="${x + 120}" y2="${Y + 170}" stroke="${p.copper}" stroke-width="2"/>
  <text class="mono" x="${x + 100}" y="${Y + 232}" font-size="12" letter-spacing="2" text-anchor="middle">YOUR SKIN</text>
  <text class="mono" x="${x + 100}" y="${Y + 254}" font-size="10" letter-spacing=".6" text-anchor="middle" fill="${p.muted}">src/skins/*.css</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" fill="${p.text}">
  <title id="t">Skins</title>
  <desc id="d">The same conversation in the OTSR skin, light and dark, next to an open slot for a new skin.</desc>
  <style>${styles(p)}</style>
  ${backdrop(p, W, H)}
  <text class="mono" x="60" y="150" font-size="13" letter-spacing="2.6" fill="${p.copper}">SKINS</text>
  <text class="sans" x="58" y="204" font-size="42" font-weight="700" letter-spacing="-0.5" fill="${p.ink}">Make it yours.</text>
  <g class="sans" font-size="17">
    <text x="60" y="250">A skin restyles the whole interface:</text>
    <text x="60" y="275">colors, corners, labels and background.</text>
    <text x="60" y="312">OTSR comes in light and dark.</text>
    <text x="60" y="337">The next skin could be yours.</text>
  </g>
  <text class="mono" x="60" y="388" font-size="11" letter-spacing="1.4" fill="${p.copper}">HOW TO · DOCS/FORK/THEMING.MD  →</text>
  ${outline(530)}${phone(PALETTES.light, 530, Y)}
  ${outline(770)}${phone(PALETTES.dark, 770, Y)}
  ${slot(1010)}
  ${label(530, 'OTSR · LIGHT', p.muted)}
  ${label(770, 'OTSR · DARK', p.muted)}
  ${label(1010, 'OPEN SLOT', p.copper)}
</svg>
`;
}

const files = {
  'hero-light.svg': hero(PALETTES.light),
  'hero-dark.svg': hero(PALETTES.dark),
  'how-it-works-light.svg': howItWorks(PALETTES.light),
  'how-it-works-dark.svg': howItWorks(PALETTES.dark),
  'skins-light.svg': skins(PALETTES.light),
  'skins-dark.svg': skins(PALETTES.dark),
};
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(OUT, name), svg);
  console.log('wrote', name);
}

// Social preview (1280x640, upload under Settings > General > Social preview).
const social = hero(PALETTES.light, { W: 1280, H: 640, dy: 40 });
try {
  const { default: sharp } = await import('sharp');
  await sharp(Buffer.from(social)).png().toFile(join(OUT, 'social-preview.png'));
  console.log('wrote social-preview.png');

  const pngDir = process.argv[process.argv.indexOf('--png') + 1];
  if (process.argv.includes('--png') && pngDir) {
    mkdirSync(pngDir, { recursive: true });
    for (const [name, svg] of Object.entries(files)) {
      await sharp(Buffer.from(svg)).png().toFile(join(pngDir, name.replace('.svg', '.png')));
    }
    console.log('previews in', pngDir);
  }
} catch (error) {
  console.warn('sharp not available, skipped PNG output:', error.message);
}
