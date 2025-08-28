import React, { useEffect, useMemo, useRef, useState } from "react";
import './App.css';

// AMQ-SRS Trainer — single-file React component
const ANILIST_GQL = "https://graphql.anilist.co";
const ANIMETHEMES_API = "https://api.animethemes.moe";

// ---- Tunables / Defaults ----
const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_SHOWS = 1000;
const MAX_STORAGE_SIZE_MB = 5; // Limite approximative en Mo
const MAX_CARDS_PER_SERIES = 5; // Limite d'OP par série

// ---- SRS (simplified) ----
function sm2Schedule(card, quality, easyDelayHours, diffAgain) {
  const now = Date.now();
  let { interval = 0, reps = 0, attempts = 0, successes = 0, due = now + 24 * 60 * 60 * 1000 } = card?.srs || {};

  attempts += 1;
  if (quality > 0) {
    successes += 1;
  }

  reps += 1;

  if (quality === 2) {  // Easy
    interval = easyDelayHours * 60 * 60 * 1000;
    due = now + interval;
  } else if (quality === 1) {  // Hard
    interval = 0;
    due = now;
  } else {  // Again
    interval = diffAgain ? 10 * 60 * 1000 : 0;
    due = now + interval;
  }

  return { interval, reps, attempts, successes, due };
}

// ---- LocalStorage helpers ----
const STORAGE_KEY = "amq_srs_state_v1";
const STORAGE_CACHE = "amq_srs_cache_v1";
const STORAGE_SETTINGS = "amq_srs_settings_v1";
const STORAGE_CARDS = "amq_srs_cards_v1";

function loadCards() {
  try { return JSON.parse(localStorage.getItem(STORAGE_CARDS) || "[]"); } catch { return []; }
}
function saveCards(cs) {
  const sizeInMB = new Blob([localStorage.getItem(STORAGE_CARDS) || "[]"], { type: 'application/json' }).size / (1024 * 1024);
  if (sizeInMB > MAX_STORAGE_SIZE_MB) {
    localStorage.removeItem(STORAGE_CARDS); // Purge si limite atteinte
  }
  localStorage.setItem(STORAGE_CARDS, JSON.stringify(cs.slice(0, DEFAULT_MAX_SHOWS)));
}

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}
function saveState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function loadCache() {
  try { return JSON.parse(localStorage.getItem(STORAGE_CACHE) || "{}"); } catch { return {}; }
}
function saveCache(cache) { localStorage.setItem(STORAGE_CACHE, JSON.stringify(cache)); }
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || "{}"); } catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(s)); }

// ---- Utils ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dedupeById(arr) {
  const map = new Map();
  for (const c of arr || []) map.set(c.id, c);
  return Array.from(map.values());
}

async function fetchJSON(url, opts) {
  let attempt = 0;
  while (true) {
    const r = await fetch(url, { ...opts, headers: { "Accept": "application/json", ...(opts?.headers || {}) } });
    if (r.ok) return r.json();

    const status = r.status;
    const retryAfter = Number(r.headers.get("Retry-After"));
    if (status === 429 || (status >= 500 && status < 600)) {
      if (attempt >= 6) {
        const text = await r.text().catch(() => "");
        throw new Error(`${status} ${r.statusText}${text ? ` — ${text}` : ""}`);
      }
      const backoff = retryAfter
        ? Math.max(1000, retryAfter * 1000)
        : Math.min(1000 * Math.pow(2, attempt), 16000) + Math.floor(Math.random() * 120);
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    const text = await r.text().catch(() => "");
    throw new Error(`${status} ${r.statusText}${text ? ` — ${text}` : ""}`);
  }
}

async function postJSON(url, body) {
  return fetchJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j] = [a[j], a[i]];
  }
  return a;
}

// ---- Import Logic ----
async function importAnilist(setCards, setLoading, setError, cards, username) {
  try {
    setLoading(true);
    setError("");
    if (!username) {
      setError("Veuillez entrer un nom d'utilisateur AniList.");
      setLoading(false);
      return;
    }

    let allEntries = [];
    let globalIndex = 0;

    const query = `
      query ($username: String) {
        MediaListCollection(userName: $username, type: ANIME) {
          lists {
            entries {
              media {
                id
                title {
                  romaji
                  english
                  native
                }
                streamingEpisodes {
                  title
                  url
                }
              }
            }
          }
        }
      }
    `;

    const variables = { username };
    const response = await postJSON(ANILIST_GQL, { query, variables });
    console.log("Réponse API complète:", response);

    const { MediaListCollection } = response.data;
    const entries = MediaListCollection.lists.flatMap(list => list.entries.map(entry => entry.media));
    console.log("Entrées brutes:", entries.length);

    allEntries = allEntries.concat(entries);

    const newCards = [];
    const seenOps = new Map(); // Map pour suivre les OP uniques par série

    allEntries.forEach(media => {
      const seriesCards = [];
      const uniqueOps = new Set();
      (media.streamingEpisodes || []).slice(0, MAX_CARDS_PER_SERIES).forEach((episode, index) => {
        globalIndex += 1;
        const opNumber = index + 1;
        const uniqueKey = `${media.id}::OP${opNumber}::${episode.url || 'none'}`;
        if (episode.url && !seenOps.has(uniqueKey) && !uniqueOps.has(opNumber)) {
          uniqueOps.add(opNumber);
          seenOps.set(uniqueKey, true);
          seriesCards.push({
            id: `${media.id}::OP${opNumber}::${globalIndex}`,
            titleRomaji: media.title.romaji || media.title.english || media.title.native,
            opNumber: opNumber,
            videoUrl: episode.url,
            artists: [],
            songTitle: `Opening ${opNumber}`, // Forcé à "Opening X" au lieu de episode.title
            srs: { due: Date.now() + 24 * 60 * 60 * 1000 },
          });
        }
      });
      if (seriesCards.length > 0) newCards.push(...seriesCards);
      // Fallback pour les séries sans épisodes
      if (seriesCards.length === 0) {
        globalIndex += 1;
        const fallbackId = `${media.id}::OP1::${globalIndex}`;
        if (!seenOps.has(fallbackId)) {
          seenOps.set(fallbackId, true);
          newCards.push({
            id: fallbackId,
            titleRomaji: media.title.romaji || media.title.english || media.title.native,
            opNumber: 1,
            videoUrl: null,
            artists: [],
            songTitle: `Opening 1`,
            srs: { due: Date.now() + 24 * 60 * 60 * 1000 },
          });
        }
      }
    });
    console.log("Cartes générées:", newCards.length);

    setCards(c => dedupeById([...c, ...newCards]).slice(0, DEFAULT_MAX_SHOWS));
    saveCards([...cards, ...newCards].slice(0, DEFAULT_MAX_SHOWS));
  } catch (err) {
    setError(`Erreur lors de l'import : ${err.message}`);
  } finally {
    setLoading(false);
  }
}

// ---- Toast Component ----
function Toast({ message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="toast animate-fadeIn">
      {message}
    </div>
  );
}

// ---- Error Boundary ----
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-red-50 text-red-700 rounded-xl">
          <h2>Une erreur est survenue</h2>
          <p>{this.state.error.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })} className="mt-2 btn--primary">
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AMQSrsTrainer() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState(loadCards());
  const [srs, setSrs] = useState(loadState());
  const [filterQuery, setFilterQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [hideVideo, setHideVideo] = useState(false);
  const answerRef = useRef(null);
  const idsRef = useRef(new Set());
  const [importProgress, setImportProgress] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");
  const [lastGrade, setLastGrade] = useState(null);
  const [currentCard, setCurrentCard] = useState(null);

  const initSettings = loadSettings();
  const [delayMs, setDelayMs] = useState(Number.isFinite(initSettings.delayMs) ? initSettings.delayMs : DEFAULT_DELAY_MS);
  const [maxShows, setMaxShows] = useState(Number.isFinite(initSettings.maxShows) ? initSettings.maxShows : DEFAULT_MAX_SHOWS);
  const [easyDelayHours, setEasyDelayHours] = useState(Number.isFinite(initSettings.easyDelayHours) ? initSettings.easyDelayHours : 48);
  const [diffAgain, setDiffAgain] = useState(!!initSettings.diffAgain);
  const [autoPlay, setAutoPlay] = useState(true);
  const [sortMode, setSortMode] = useState(initSettings.sortMode || "alpha");
  const [cache, setCache] = useState(loadCache());

  useEffect(() => {
    saveSettings({ delayMs, maxShows, easyDelayHours, diffAgain, autoPlay, sortMode });
  }, [delayMs, maxShows, easyDelayHours, diffAgain, autoPlay, sortMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const handleKey = (e) => {
      if (showAnswer && currentCard) {
        if (e.key === "a" || e.key === "1") grade(0);
        if (e.key === "h" || e.key === "2") grade(1);
        if (e.key === "e" || e.key === "3") grade(2);
      } else if (e.key === "Enter" && answerRef.current) {
        setShowAnswer(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showAnswer, currentCard]);

  function grade(quality) {
    if (!currentCard) return;
    const prevSrs = srs[currentCard.id];
    setLastGrade({ id: currentCard.id, prevSrs });
    const newSrs = sm2Schedule(currentCard, quality, easyDelayHours, diffAgain);
    setSrs(s => ({ ...s, [currentCard.id]: newSrs }));
    setToast(`Noté : ${["Again", "Hard", "Easy"][quality]}`);
    if (hideVideo) {
      setShowAnswer(false);
      if (answerRef.current) {
        answerRef.current.value = "";
        answerRef.current.focus();
      }
      const newCurrent = deck.due.length > 0 ? shuffle(deck.due)[0] : (deck.later.length > 0 ? shuffle(deck.later)[0] : null);
      setCurrentCard(newCurrent);
    } else {
      setTimeout(() => {
        setShowAnswer(false);
        if (answerRef.current) {
          answerRef.current.value = "";
          answerRef.current.focus();
        }
        const newCurrent = deck.due.length > 0 ? shuffle(deck.due)[0] : (deck.later.length > 0 ? shuffle(deck.later)[0] : null);
        setCurrentCard(newCurrent);
      }, 500);
    }
  }

  function undoGrade() {
    if (!lastGrade) return;
    setSrs(s => ({ ...s, [lastGrade.id]: lastGrade.prevSrs }));
    setLastGrade(null);
    setToast("Undo effectué");
  }

  const deck = useMemo(() => {
    const now = Date.now();
    const all = cards.map(c => ({ ...c, srs: srs[c.id] || {} }));
    const filtered = all.filter(c => {
      if (!filterQuery) return true;
      const q = filterQuery.toLowerCase();
      return (
        (c.titleRomaji || "").toLowerCase().includes(q) ||
        (c.titleEnglish || "").toLowerCase().includes(q) ||
        (c.titleNative || "").toLowerCase().includes(q) ||
        (c.songTitle || "").toLowerCase().includes(q) ||
        (c.artists || []).some(a => a.toLowerCase().includes(q))
      );
    });
    const due = filtered.filter(c => !c.srs.due || c.srs.due <= now);
    const later = filtered.filter(c => c.srs.due && c.srs.due > now);
    return { all: filtered, due, later };
  }, [cards, srs, filterQuery]);

  const sortedDeck = useMemo(() => {
    return [...deck.all].sort((a, b) => {
      if (sortMode === "due") {
        const dueA = a.srs?.due || 0;
        const dueB = b.srs?.due || 0;
        return dueA - dueB || (a.titleRomaji || a.titleEnglish || a.titleNative || "").localeCompare(b.titleRomaji || b.titleEnglish || b.titleNative || "");
      }
      if (sortMode === "success") {
        const successA = a.srs?.attempts > 0 ? a.srs.successes / a.srs.attempts : 0;
        const successB = b.srs?.attempts > 0 ? b.srs.successes / b.srs.attempts : 0;
        return successB - successA || (a.titleRomaji || a.titleEnglish || a.titleNative || "").localeCompare(b.titleRomaji || b.titleEnglish || b.titleNative || "");
      }
      const titleA = (a.titleRomaji || a.titleEnglish || a.titleNative || "").toLowerCase();
      const titleB = (b.titleRomaji || b.titleEnglish || b.titleNative || "").toLowerCase();
      return titleA.localeCompare(titleB);
    });
  }, [deck.all, sortMode]);

  const globalStats = useMemo(() => {
    const totalCards = deck.all.length;
    const dueCards = deck.due.length;
    const totalAttempts = deck.all.reduce((sum, c) => sum + (c.srs.attempts || 0), 0);
    const totalSuccesses = deck.all.reduce((sum, c) => sum + (c.srs.successes || 0), 0);
    const successRate = totalAttempts > 0 ? Math.round((totalSuccesses / totalAttempts) * 100) : 0;
    return { totalCards, dueCards, successRate };
  }, [deck]);

  useEffect(() => {
    let newCurrent;
    if (deck.all.length > 0) {
      newCurrent = shuffle(deck.all)[0];
    } else {
      newCurrent = null;
    }
    setCurrentCard(newCurrent);
  }, [deck.all]);

  const pageSize = 50;
  const paginatedDeck = sortedDeck.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
        <div className="flex justify-center">
          <div className="max-w-4xl w-full">
            <header className="mb-6 flex items-center justify-between">
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7L12 12L22 7L12 2Z" />
                  <path d="M2 17L12 22L22 17" />
                  <path d="M2 12L12 17L22 12" />
                </svg>
                Melfisk AMQ Training
                <span className="text-sm font-normal">(AniList → AnimeThemes → Anki-style)</span>
              </h1>
              <div className="flex gap-3">
                <button className="text-sm underline" onClick={() => setShowSettings(s => !s)}>
                  {showSettings ? "Fermer" : "Réglages"}
                </button>
                <button className="text-sm underline" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                  {theme === "dark" ? "Light" : "Dark"}
                </button>
              </div>
            </header>

            <div className="mb-4 flex justify-center gap-4 text-sm text-gray-600">
              <span>Total cartes: {globalStats.totalCards}</span>
              <span>Cartes dues: {globalStats.dueCards}</span>
              <span>Taux de succès: {globalStats.successRate}%</span>
            </div>

            {showSettings && (
              <div className="modal-overlay" onClick={() => setShowSettings(false)>
                <section className="modal-content mb-6 rounded-2xl border p-4 bg-white shadow-sm animate-fadeIn" onClick={e => e.stopPropagation()}>
                  <h2 className="text-lg font-bold mb-3">Réglages</h2>
                  <div className="grid gap-4">
                    <div>
                      <label className="text-sm text-gray-600 mb-1 block">Délai Easy (heures)</label>
                      <input
                        type="number"
                        min="1"
                        max="720"
                        className="w-full rounded-2xl border px-4 py-2"
                        value={easyDelayHours}
                        onChange={(e) => setEasyDelayHours(Math.max(1, Math.min(720, parseInt(e.target.value) || 48)))}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="diffAgain"
                        checked={diffAgain}
                        onChange={(e) => setDiffAgain(e.target.checked)}
                        className="rounded border"
                      />
                      <label htmlFor="diffAgain" className="text-sm text-gray-600">
                        Différencier Again (10min) et Hard (immédiat)
                      </label>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="autoPlay"
                        checked={autoPlay}
                        onChange={(e) => setAutoPlay(e.target.checked)}
                        className="rounded border"
                      />
                      <label htmlFor="autoPlay" className="text-sm text-gray-600">
                        Lecture automatique des vidéos
                      </label>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600 mb-1 block">Trier le deck par</label>
                      <select
                        className="w-full rounded-2xl border px-4 py-2"
                        value={sortMode}
                        onChange={(e) => setSortMode(e.target.value)}
                      >
                        <option value="alpha">Titre (alphabétique)</option>
                        <option value="due">Échéance</option>
                        <option value="success">Taux de succès</option>
                      </select>
                    </div>
                    <div>
                      <button
                        className="rounded-2xl px-4 py-2 border btn--danger"
                        onClick={() => {
                          if (confirm("Réinitialiser toutes les stats SRS (échéances, succès, essais) ?")) {
                            setSrs({});
                            localStorage.removeItem(STORAGE_KEY);
                            setToast("Stats SRS réinitialisées");
                          }
                        }}
                      >
                        Réinitialiser les stats SRS
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            <section className="mb-4 grid md:grid-cols-3 gap-3 items-end">
              <div>
                <input
                  className="w-full rounded-2xl border px-4 py-2"
                  placeholder="AniList username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && username) importAnilist(setCards, setLoading, setError, cards, username); }}
                />
              </div>
              <div>
                <input
                  className="w-full rounded-2xl border px-4 py-2"
                  placeholder="Filtrer (titre, chanson, artistes)"
                  value={filterQuery}
                  onChange={e => setFilterQuery(e.target.value)}
                />
              </div>
              <div className="flex justify-end items-center gap-2">
                <button
                  className="rounded-2xl px-4 py-2 border"
                  onClick={() => setHideVideo(s => !s)}
                >
                  {hideVideo ? "Afficher" : "Cacher"} vidéo
                </button>
                <button
                  className="rounded-2xl px-4 py-2 border btn--primary"
                  disabled={loading || !username}
                  onClick={() => importAnilist(setCards, setLoading, setError, cards, username)}
                >
                  Importer
                </button>
              </div>
            </section>

            {loading && (
              <section className="mb-6 animate-pulse">
                <div className="text-sm mb-2 text-gray-600">Importation en cours ({importProgress} / {idsRef.current.size})</div>
                <div className="progress">
                  <div
                    className="progress__bar"
                    style={{ width: `${(importProgress / (idsRef.current.size || 1)) * 100}%` }}
                  />
                </div>
              </section>
            )}

            {toast && <Toast message={toast} onClose={() => setToast("")} />}

            <section id="review" className="mb-6 flex justify-center">
              {error && (
                <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-xl text-sm animate-fadeIn">
                  {error}
                </div>
              )}
              {currentCard ? (
                <div className="review-card p-4 rounded-2xl border bg-white shadow-sm w-full max-w-2xl">
                  {currentCard.videoUrl ? (
                    <div className="mb-4 video-shell">
                      <div
                        style={{
                          position: "relative",
                          width: "100%",
                          maxWidth: 720,
                          aspectRatio: "16 / 9",
                          overflow: "hidden",
                          borderRadius: 12,
                          background: "#000",
                          margin: "0 auto",
                        }}
                      >
                        <video
                          src={currentCard.videoUrl}
                          controls
                          autoPlay={autoPlay}
                          preload="metadata"
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            filter: hideVideo ? "brightness(0) contrast(0)" : "none",
                            zIndex: 0,
                          }}
                        />
                        {hideVideo && (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              background: "#000",
                              opacity: 1,
                              zIndex: 5,
                              pointerEvents: "none",
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mb-4 p-4 bg-gray-100 rounded-xl text-center text-sm">
                      Pas d'aperçu vidéo disponible.
                    </div>
                  )}

                  <div className="mb-3">
                    <input
                      ref={answerRef}
                      className="w-full rounded-2xl border px-4 py-2"
                      placeholder="Tape ta réponse (titre de l'anime)"
                      onKeyDown={(e) => { if (e.key === "Enter") setShowAnswer(true); }}
                    />
                  </div>

                  {!showAnswer ? (
                    <div className="flex justify-center">
                      <button className="rounded-2xl px-6 py-2 border btn--primary" onClick={() => setShowAnswer(true)}>
                        Révéler
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2 animate-reveal">
                      <div className="text-center">
                        <div className="text-xl font-bold">{currentCard.titleRomaji || currentCard.titleEnglish || currentCard.titleNative}</div>
                        <div className="text-sm text-gray-600">OP{currentCard.opNumber || 1} — {currentCard.songTitle || 'Titre inconnu'} {currentCard.artists ? `• ${currentCard.artists.join(", ")}` : ''}</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        <button className="rounded-xl px-3 py-2 bg-red-50 border border-red-200" onClick={() => grade(0)}>Again (A)</button>
                        <button className="rounded-xl px-3 py-2 bg-yellow-50 border border-yellow-200" onClick={() => grade(1)}>Hard (H)</button>
                        <button className="rounded-xl px-3 py-2 bg-blue-50 border border-blue-200" onClick={() => grade(2)}>Easy (E)</button>
                      </div>
                      {lastGrade && (
                        <button className="text-sm underline mt-2" onClick={undoGrade}>
                          Undo dernier grade
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mb-4 p-4 bg-gray-100 rounded-xl text-center text-sm">
                  Aucune carte à réviser. Importe un utilisateur AniList pour commencer.
                </div>
              )}
            </section>

            <section className="mt-6 flex justify-center">
              <div className="w-full max-w-4xl">
                <div className="text-sm mb-2 text-gray-600 flex justify-between items-center">
                  Deck ({deck.all.length})
                  <div className="flex gap-2">
                    <button
                      className="rounded-xl px-3 py-2 border"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(p => p - 1)}
                    >
                      Préc
                    </button>
                    <span>Page {currentPage} / {Math.ceil(sortedDeck.length / pageSize)}</span>
                    <button
                      className="rounded-xl px-3 py-2 border"
                      disabled={currentPage >= Math.ceil(sortedDeck.length / pageSize)}
                      onClick={() => setCurrentPage(p => p + 1)}
                    >
                      Suiv
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm table mx-auto">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-2 pr-2">Anime</th>
                        <th className="py-2 pr-2">OP</th>
                        <th className="py-2 pr-2">Chanson</th>
                        <th className="py-2 pr-2">Artistes</th>
                        <th className="py-2 pr-2">Échéance</th>
                        <th className="py-2 pr-2">Succès</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedDeck.map(c => (
                        <tr key={c.id} className="border-b hover:bg-gray-50">
                          <td className="py-2 pr-2">{c.titleRomaji || c.titleEnglish || c.titleNative}</td>
                          <td className="py-2 pr-2">OP{c.opNumber || 1}</td>
                          <td className="py-2 pr-2">{c.songTitle || "—"}</td>
                          <td className="py-2 pr-2">{c.artists ? c.artists.join(", ") : "?"}</td>
                          <td className="py-2 pr-2">{c.srs?.due ? new Date(c.srs.due).toLocaleString() : "à réviser"}</td>
                          <td className="py-2 pr-2">
                            {c.srs?.attempts > 0
                              ? `${Math.round((c.srs.successes / c.srs.attempts) * 100)}% (${c.srs.successes}/${c.srs.attempts})`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <footer className="mt-8 text-xs text-gray-500 flex justify-center">
              <div>
                <p>
                  Sources : AniList GraphQL • AnimeThemes.moe. Ce projet n'est affilié ni à AMQ ni à Anki.
                </p>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}