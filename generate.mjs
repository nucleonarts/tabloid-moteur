// Tabloïd : moteur de résumés
// Lancé automatiquement par GitHub toutes les heures (fichier tabloid.yml).
// 1. lit les flux RSS des journaux
// 2. demande à Claude un flash très condensé, en français
// 3. écrit public/digest.json (lu par l'app et les widgets) et public/index.html (page de contrôle)
//
// Aucune dépendance à installer : Node.js 20 ou plus suffit.

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// ---- Réglages ----------------------------------------------------------------
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const API_URL = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_PER_SOURCE = 6; // articles retenus par journal
const MAX_AGE_HOURS = 30; // on ignore les articles plus anciens
const MAX_STORIES = 15; // nombre maximum d'infos dans le flash
const OUT_DIR = "public";

// Modifiez librement cette liste. Un flux qui ne répond pas est simplement ignoré.
const FEEDS = [
  { source: "Franceinfo", url: "https://www.francetvinfo.fr/titres.rss" },
  { source: "Le Monde", url: "https://www.lemonde.fr/rss/une.xml" },
  { source: "Le Figaro", url: "https://www.lefigaro.fr/rss/figaro_actualites.xml" },
  { source: "Libération", url: "https://www.liberation.fr/arc/outboundfeeds/rss-all/collection/accueil-une/?outputType=xml" },
  { source: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { source: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
];

const CATEGORIES = ["Monde", "France", "Politique", "Économie", "Société", "Science & Tech", "Culture", "Sport"];

const SYSTEM_PROMPT = `Tu es le rédacteur en chef d'un flash d'information ultra-condensé, en français.
On te donne une liste numérotée d'articles récents (titre + extrait, parfois en anglais).

Règles :
- Regroupe les articles qui parlent du même événement en UN seul élément et indique tous leurs numéros dans "articleIds" (le premier est l'article de référence, de préférence un média français).
- Garde au maximum ${MAX_STORIES} éléments, du plus important au moins important.
- "headline" : titre percutant de 12 mots maximum, en français.
- "summary" : UNE seule phrase de 25 mots maximum, factuelle, sans jugement ni sensationnalisme.
- "category" : une valeur parmi ${CATEGORIES.map((c) => `"${c}"`).join(", ")}.
- N'invente rien : appuie-toi uniquement sur les titres et extraits fournis.
- Réponds UNIQUEMENT avec un tableau JSON, sans texte autour ni balises de code, au format :
[{"headline":"...","summary":"...","category":"...","articleIds":[0,3]}]`;

// ---- Lecture des flux RSS / Atom ---------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function clean(raw) {
  const noCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const noTags = decodeEntities(noCdata).replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

function tagContent(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1] : "";
}

function atomLink(block) {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  for (const link of links) {
    const href = link.match(/href\s*=\s*["']([^"']+)["']/i);
    const rel = link.match(/rel\s*=\s*["']([^"']+)["']/i);
    if (href && (!rel || rel[1] === "alternate")) return decodeEntities(href[1]);
  }
  return "";
}

function safeUrl(text) {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;

  return blocks
    .map((block) => {
      const url = safeUrl(clean(tagContent(block, "link"))) || safeUrl(atomLink(block)) || safeUrl(clean(tagContent(block, "guid")));
      const dateText = clean(tagContent(block, "pubDate") || tagContent(block, "dc:date") || tagContent(block, "published") || tagContent(block, "updated"));
      const date = dateText ? new Date(dateText) : new Date();
      return {
        source,
        title: clean(tagContent(block, "title")),
        snippet: clean(tagContent(block, "description") || tagContent(block, "summary") || tagContent(block, "content")).slice(0, 400),
        url,
        time: Number.isNaN(date.getTime()) ? Date.now() : date.getTime(),
      };
    })
    .filter((item) => item.title && item.url && item.time >= cutoff)
    .slice(0, MAX_PER_SOURCE);
}

async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: { "User-Agent": "Tabloid/1.0 (flash d'actualite personnel)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = parseFeed(await response.text(), feed.source);
    console.log(`✓ ${feed.source} : ${items.length} article(s)`);
    return items;
  } catch (error) {
    console.warn(`⚠︎ ${feed.source} ignoré (${error.message})`);
    return [];
  }
}

// ---- Résumé par Claude ---------------------------------------------------------
function explainApiError(status, detail) {
  if (status === 401) return `Clé API refusée (401). Vérifiez le secret ANTHROPIC_API_KEY dans les réglages GitHub. Détail : ${detail}`;
  if (/credit balance/i.test(detail)) return `Crédit Claude épuisé. Rechargez sur https://console.anthropic.com (Billing). Détail : ${detail}`;
  if (status === 404) return `Modèle introuvable (${MODEL}). Détail : ${detail}`;
  return `Erreur de l'API Claude (${status}). Détail : ${detail}`;
}

async function callClaude(userText) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    }
    const detail = body?.error?.message || response.statusText;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 3) {
      console.warn(`Claude occupé (${response.status}), nouvel essai dans 20 s…`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      continue;
    }
    throw new Error(explainApiError(response.status, detail));
  }
}

export function buildStories(rawText, articles, dayStamp) {
  const text = rawText.replace(/```(?:json)?/g, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("Réponse de Claude illisible (pas de tableau JSON).");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Réponse de Claude illisible (pas un tableau).");

  return parsed
    .map((entry) => {
      const ids = [...new Set((Array.isArray(entry.articleIds) ? entry.articleIds : []).map(Number))]
        .filter((i) => Number.isInteger(i) && articles[i]);
      const headline = String(entry.headline ?? "").trim();
      const summary = String(entry.summary ?? "").trim();
      if (ids.length === 0 || !headline || !summary) return null;
      return {
        headline,
        summary,
        category: CATEGORIES.includes(entry.category) ? entry.category : "Monde",
        articles: ids.map((i) => ({ source: articles[i].source, title: articles[i].title, url: articles[i].url })),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_STORIES)
    .map((story, index) => ({ id: `${dayStamp}-${index}`, ...story }));
}

// ---- Page de contrôle ---------------------------------------------------------
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function statusPage(digest) {
  const when = new Date(digest.generatedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" });
  const items = digest.stories
    .map((s) => `<li><small>${escapeHtml(s.category)}</small><br><a href="${escapeHtml(s.articles[0].url)}">${escapeHtml(s.headline)}</a><br>${escapeHtml(s.summary)}</li>`)
    .join("\n");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tabloïd</title><style>body{font:16px/1.45 -apple-system,system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#222}
h1{color:#d7261e;margin-bottom:.2rem}li{margin:0 0 1rem}small{color:#d7261e;font-weight:700;text-transform:uppercase}a{color:#222;font-weight:600}</style></head>
<body><h1>Tabloïd fonctionne ✓</h1><p>${digest.stories.length} infos · mis à jour le ${escapeHtml(when)} (heure de Paris).</p><p>Adresse à copier dans <b>Config.swift</b> :<br><code id="u">…/digest.json</code></p>
<script>document.getElementById("u").textContent = new URL("digest.json", location.href).href;</script>
<ol>${items}</ol></body></html>`;
}

// ---- Programme principal ----------------------------------------------------------
async function main() {
  if (!API_KEY) {
    throw new Error("Clé API absente. Ajoutez le secret ANTHROPIC_API_KEY dans GitHub : Settings > Secrets and variables > Actions.");
  }

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const seen = new Set();
  const articles = results.flat().filter((a) => !seen.has(a.url) && seen.add(a.url));
  if (articles.length === 0) throw new Error("Aucun article récupéré : tous les flux ont échoué.");
  console.log(`${articles.length} articles envoyés à Claude (${MODEL})…`);

  const list = articles.map((a, i) => `[${i}] (${a.source}) ${a.title}\n${a.snippet}`).join("\n\n");
  const now = new Date();
  const stories = buildStories(await callClaude(list), articles, now.toISOString().slice(0, 10));
  if (stories.length === 0) throw new Error("Claude n'a renvoyé aucune info exploitable.");

  const digest = { generatedAt: now.toISOString(), stories };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/digest.json`, JSON.stringify(digest, null, 2));
  await writeFile(`${OUT_DIR}/index.html`, statusPage(digest));
  console.log(`✓ Flash prêt : ${stories.length} infos.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
