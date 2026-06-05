-- Sources de veille (RSS, YouTube, Reddit, etc.)
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  theme       TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  limit_count INTEGER NOT NULL DEFAULT 5,
  is_active   INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Articles pré-fetchés par le cron
CREATE TABLE IF NOT EXISTS articles (
  hash             TEXT PRIMARY KEY,
  theme            TEXT NOT NULL,
  classified_theme TEXT,             -- thème détecté par Workers AI (peut différer de theme)
  title            TEXT NOT NULL,
  source_name      TEXT NOT NULL,
  url              TEXT,
  content          TEXT,
  published_at     INTEGER,
  fetched_at       INTEGER NOT NULL
);

-- Cache d'embeddings pour recherche sémantique
CREATE TABLE IF NOT EXISTS article_embeddings (
  article_hash   TEXT PRIMARY KEY,
  model          TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Config dynamique (clés feature flag, valeurs ajustables sans rebuild)
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Suggestions IA (thèmes émergents + chaînes YouTube)
CREATE TABLE IF NOT EXISTS suggestions (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,           -- 'new_theme' | 'youtube_channel'
  name         TEXT NOT NULL,           -- Nom affiché
  description  TEXT NOT NULL,           -- Pourquoi c'est suggéré
  theme        TEXT,                    -- Thème cible (pour youtube_channel)
  value        TEXT NOT NULL,           -- slug pour new_theme, channel_id pour youtube
  extra_json   TEXT NOT NULL DEFAULT '{}', -- sources de démarrage pour new_theme
  generated_at INTEGER NOT NULL,
  is_applied   INTEGER NOT NULL DEFAULT 0,
  is_dismissed INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_active ON suggestions(is_applied, is_dismissed);

-- Podcasts auto-générés par le cron quotidien
CREATE TABLE IF NOT EXISTS podcast_feed (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  theme          TEXT NOT NULL DEFAULT 'general',
  format         TEXT NOT NULL DEFAULT 'daily',  -- 'daily' | 'deep_dive'
  generated_at   INTEGER NOT NULL,
  segment_count  INTEGER NOT NULL DEFAULT 0,
  segments_json  TEXT NOT NULL DEFAULT '[]',  -- [{id,type,speaker,text}] sans audioUri
  is_ready       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
-- Migration pour les bases existantes (ignorer l'erreur si la colonne existe déjà)
-- wrangler d1 execute techpulse --command="ALTER TABLE podcast_feed ADD COLUMN format TEXT NOT NULL DEFAULT 'daily'"

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_articles_theme       ON articles(theme);
CREATE INDEX IF NOT EXISTS idx_articles_fetched_at  ON articles(fetched_at);
CREATE INDEX IF NOT EXISTS idx_articles_classified  ON articles(classified_theme);
CREATE INDEX IF NOT EXISTS idx_article_embeddings_updated_at ON article_embeddings(updated_at);
CREATE INDEX IF NOT EXISTS idx_sources_theme        ON sources(theme);
CREATE INDEX IF NOT EXISTS idx_sources_active       ON sources(is_active);
CREATE INDEX IF NOT EXISTS idx_podcast_generated    ON podcast_feed(generated_at);

-- Sources par défaut
INSERT OR IGNORE INTO sources VALUES
  ('src_hn',          'Hacker News',          'general',    'hackernews_rss',  'https://hnrss.org/frontpage',                                               5,  1, 1, datetime('now'), datetime('now')),
  ('src_verge',       'The Verge Tech',        'general',    'rss',             'https://www.theverge.com/rss/index.xml',                                     6,  1, 1, datetime('now'), datetime('now')),
  ('src_ars',         'Ars Technica',          'general',    'rss',             'https://feeds.arstechnica.com/arstechnica/index',                            6,  1, 1, datetime('now'), datetime('now')),
  ('src_github',      'GitHub Blog',           'general',    'rss',             'https://github.blog/feed/',                                                  5,  1, 1, datetime('now'), datetime('now')),
  ('src_tc',          'TechCrunch',            'business',   'rss',             'https://techcrunch.com/feed/',                                               6,  1, 1, datetime('now'), datetime('now')),
  ('src_reuters',     'Reuters Tech',          'business',   'rss',             'https://news.google.com/rss/search?q=site:reuters.com+technology&hl=en-US&gl=US&ceid=US:en', 6, 1, 1, datetime('now'), datetime('now')),
  ('src_cnbc_tech',   'CNBC Tech',             'business',   'rss',             'https://news.google.com/rss/search?q=site:cnbc.com+(technology+OR+artificial+intelligence+OR+chips+OR+software)&hl=en-US&gl=US&ceid=US:en', 6, 1, 1, datetime('now'), datetime('now')),
  ('src_reuters_mkts','Reuters Markets',       'finance',    'rss',             'https://news.google.com/rss/search?q=site:reuters.com+markets&hl=en-US&gl=US&ceid=US:en',    6, 1, 1, datetime('now'), datetime('now')),
  ('src_cnbc_mkts',   'CNBC Markets',          'finance',    'rss',             'https://news.google.com/rss/search?q=site:cnbc.com+markets&hl=en-US&gl=US&ceid=US:en',       6, 1, 1, datetime('now'), datetime('now')),
  ('src_reuters_crypto','Reuters Crypto',      'finance',    'rss',             'https://news.google.com/rss/search?q=site:reuters.com+crypto+OR+bitcoin+OR+ethereum&hl=en-US&gl=US&ceid=US:en', 5, 1, 1, datetime('now'), datetime('now')),
  ('src_coindesk',    'CoinDesk',              'finance',    'rss',             'https://www.coindesk.com/arc/outboundfeeds/rss/',                            5, 1, 1, datetime('now'), datetime('now')),
  ('src_decrypt',     'Decrypt',               'finance',    'rss',             'https://news.google.com/rss/search?q=site:decrypt.co+crypto+OR+bitcoin+OR+ethereum&hl=en-US&gl=US&ceid=US:en', 5, 1, 1, datetime('now'), datetime('now')),
  ('src_rn',          'Reddit r/reactnative',  'general',    'reddit_rss',      'r/reactnative',                                                              6,  1, 1, datetime('now'), datetime('now')),
  ('src_rnblog',      'React Native Blog',     'general',    'rss',             'https://reactnative.dev/blog/rss.xml',                                       5,  1, 1, datetime('now'), datetime('now')),
  ('src_expo',        'Expo Blog',             'general',    'rss',             'https://blog.expo.dev/feed',                                                 5,  1, 1, datetime('now'), datetime('now')),
  ('src_rml',         'Reddit r/ML',           'ai',         'reddit_rss',      'r/MachineLearning',                                                          5,  1, 1, datetime('now'), datetime('now')),
  ('src_openai',      'OpenAI News',           'ai',         'rss',             'https://openai.com/news/rss.xml',                                            5,  1, 1, datetime('now'), datetime('now')),
  ('src_google_ai',   'Google AI Blog',        'ai',         'rss',             'https://blog.research.google/atom.xml',                                      5,  1, 1, datetime('now'), datetime('now')),
  ('src_reuters_ai',  'Reuters AI & Semis',    'ai',         'rss',             'https://news.google.com/rss/search?q=site:reuters.com+(artificial+intelligence+OR+semiconductors+OR+custom+chips+OR+data+center+OR+model+providers+OR+sovereign+AI+OR+AI+infrastructure)&hl=en-US&gl=US&ceid=US:en', 6, 1, 1, datetime('now'), datetime('now')),
  ('src_hf',          'Hugging Face Blog',     'ai',         'rss',             'https://huggingface.co/blog/feed.xml',                                       5,  1, 1, datetime('now'), datetime('now')),
  ('src_mit_ai',      'MIT Technology Review', 'ai',         'rss',             'https://www.technologyreview.com/topic/artificial-intelligence/feed/',        5,  1, 1, datetime('now'), datetime('now')),
  ('src_startups',    'Reddit r/startups',     'startups',   'reddit_rss',      'r/startups',                                                                 5,  1, 1, datetime('now'), datetime('now')),
  ('src_oss',         'Reddit r/opensource',   'opensource',  'reddit_rss',     'r/opensource',                                                               5,  1, 1, datetime('now'), datetime('now')),
  ('src_fed',         'Federal Reserve',       'economy',    'rss',             'https://news.google.com/rss/search?q=site:federalreserve.gov+economy+OR+rates+OR+inflation&hl=en-US&gl=US&ceid=US:en', 5, 1, 1, datetime('now'), datetime('now')),
  ('src_ecb',         'ECB',                   'economy',    'rss',             'https://news.google.com/rss/search?q=site:ecb.europa.eu+economy+OR+inflation+OR+rates&hl=en-US&gl=US&ceid=US:en',       5, 1, 1, datetime('now'), datetime('now')),
  ('src_imf',         'IMF',                   'economy',    'rss',             'https://news.google.com/rss/search?q=site:imf.org+economy+OR+growth+OR+inflation&hl=en-US&gl=US&ceid=US:en',            5, 1, 1, datetime('now'), datetime('now')),
  ('src_grok_tech',   'Grok Live Tech',        'general',    'grok_live',       'latest developer platform and software infrastructure news today: major framework releases, cloud platform launches, database and backend infrastructure updates, browser platform changes, developer tooling launches, notable engineering announcements from major tech companies', 5, 1, 1, datetime('now'), datetime('now')),
  ('src_grok_ai',     'Grok Live IA',          'ai',         'grok_live',       'latest artificial intelligence news today: frontier model launches, major AI product releases, inference infrastructure, AI chips and compute, hyperscaler AI capex, enterprise AI platform shifts, European AI labs, sovereign AI infrastructure, custom silicon efforts, AI data-center buildouts', 5, 1, 1, datetime('now'), datetime('now')),
  ('src_grok_finance','Grok Live Markets',     'finance',    'grok_live',       'latest markets and tech finance news today: AI capex, hyperscaler earnings, semiconductor demand, cloud margins, fintech infrastructure, crypto market structure, bitcoin ETF flows, stablecoins regulation, major funding and M&A in tech', 5, 1, 1, datetime('now'), datetime('now'));
