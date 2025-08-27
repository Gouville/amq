import React, { useEffect, useMemo, useRef, useState } from "react";

// AMQ‑SRS Trainer — single‑file React component
// Features
// - Fetch your AniList anime
// - Fetch openings (OP) from AnimeThemes.moe mapped by AniList ID
// - Build SRS flashcards (SM‑2 like) with grades: Again / Hard / Good / Easy
// - LocalStorage persistence of card scheduling
// - Play video/audio preview if available; reveal answer; type to self‑check
// - Simple filters + progress indicators
// - Rate‑limit friendly: retry with backoff + delay between requests + local cache + import cap
// - Incremental import + progress bar + start reviewing while importing

const ANILIST_GQL = "https://graphql.anilist.co";
//const ANIMETHEMES_API = "https://api.animethemes.moe/anime";
const ANIMETHEMES_API = "https://api.animethemes.moe";

// ---- Tunables / Defaults ----
const DEFAULT_DELAY_MS = 500; // polite delay between external requests
const MAX_RETRIES = 6;        // exponential backoff retries for 429/5xx
const JITTER_MS = 120;        // random jitter to avoid thundering herd
const DEFAULT_MAX_SHOWS = 250;// cap imported shows per run to avoid bursts

// ---- SRS (SM-2 simplified) ----
function sm2Schedule(card, quality) {
  // card: { ef, interval, reps, due } (ms)
  // quality: 0(Again), 1(Hard), 2(Good), 3(Easy)
  const now = Date.now();
  let { ef = 2.5, interval = 0, reps = 0 } = card || {};

  if (quality === 0) {
    // Again → relearn: next in 10 minutes
    return { ef: Math.max(1.3, ef - 0.2), interval: 10 * 60 * 1000, reps: 0, due: now + 10 * 60 * 1000 };
  }

  // Convert to 0..5 scale for EF update (Hard≈3, Good≈4, Easy≈5)
  const qMap = [2, 3, 4, 5];
  const q = qMap[quality];
  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  ef = Math.max(1.3, Math.min(2.8, ef));

  if (reps === 0) {
    interval = 24 * 60 * 60 * 1000; // 1 day
  } else if (reps === 1) {
    interval = 6 * 24 * 60 * 60 * 1000; // 6 days
  } else {
    interval = Math.round(interval * ef);
  }

  return { ef, interval, reps: reps + 1, due: now + interval };
}

// ---- LocalStorage helpers ----
const STORAGE_KEY = "amq_srs_state_v1";               // scheduling only
const STORAGE_CACHE = "amq_srs_cache_v1";             // per‑anime OP cache { [anilistId]: openings[] }
const STORAGE_SETTINGS = "amq_srs_settings_v1";        // delay/maxShows
const STORAGE_CARDS = "amq_srs_cards_v1";

function loadCards() {
  try { return JSON.parse(localStorage.getItem(STORAGE_CARDS) || "[]"); } catch { return []; }
}
function saveCards(cs) {
  localStorage.setItem(STORAGE_CARDS, JSON.stringify(cs));
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
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function dedupeById(arr) {
  const map = new Map();
  for (const c of arr || []) map.set(c.id, c); // keep last occurrence per id
  return Array.from(map.values());
}

// ---- Networking helpers with retry/backoff ----
async function fetchJSON(url, opts) {
  let attempt = 0;
  while (true) {
    const r = await fetch(url, { ...opts, headers: { "Accept": "application/json", ...(opts?.headers || {}) } });
    if (r.ok) return r.json();

    const status = r.status;
    // Respect Retry-After if present
    const retryAfter = Number(r.headers.get("Retry-After"));
    if (status === 429 || (status >= 500 && status < 600)) {
      if (attempt >= MAX_RETRIES) {
        const text = await r.text().catch(()=>"");
        throw new Error(`${status} ${r.statusText}${text ? ` — ${text}` : ""}`);
      }
      const backoff = retryAfter
        ? Math.max(1000, retryAfter * 1000)
        : Math.min(1000 * Math.pow(2, attempt), 16000) + Math.floor(Math.random() * JITTER_MS);
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    const text = await r.text().catch(()=>"");
    throw new Error(`${status} ${r.statusText}${text ? ` — ${text}` : ""}`);
  }
}

async function postJSON(url, body) {
  return fetchJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// ---- Data shapes ----
// Card id: `${anilistId}::OP${seq || 1}`
// Card data: { id, anilistId, titleRomaji, titleEnglish, titleNative, season, year, opNumber, songTitle, artists, videoUrl }

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function AMQSrsTrainer() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState(loadCards());
  const [srs, setSrs] = useState(loadState()); // id -> {ef, interval, reps, due}
  const [filterQuery, setFilterQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [hideVideo, setHideVideo] = useState(false);
  const answerRef = useRef(null);

  const initSettings = loadSettings();
  const [delayMs, setDelayMs] = useState(Number.isFinite(initSettings.delayMs) ? initSettings.delayMs : DEFAULT_DELAY_MS);
  const [maxShows, setMaxShows] = useState(Number.isFinite(initSettings.maxShows) ? initSettings.maxShows : DEFAULT_MAX_SHOWS);
  const [cache, setCache] = useState(loadCache());

  // incremental import support
  const idsRef = useRef(new Set());
  const cancelImportRef = useRef(false);
  const [progress, setProgress] = useState({ totalShows: 0, processedShows: 0, totalOps: 0 });

  useEffect(() => { saveState(srs); }, [srs]);
  useEffect(() => { saveCache(cache); }, [cache]);
  useEffect(() => { saveSettings({ delayMs, maxShows }); }, [delayMs, maxShows]);
  useEffect(() => { saveCards(cards); }, [cards]);

  // Compute due cards
  const now = Date.now();
  const deck = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const filtered = cards.filter(c => {
      if (!q) return true;
      const hay = [c.titleRomaji, c.titleEnglish, c.titleNative, c.songTitle, c.artists]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    const withMeta = filtered.map(c => ({
      ...c,
      srs: srs[c.id] || { ef: 2.5, interval: 0, reps: 0, due: 0 },
    }));
    const due = withMeta.filter(c => (c.srs.due || 0) <= now);
    const later = withMeta.filter(c => (c.srs.due || 0) > now);

    // mélanger au lieu de trier
    return { all: withMeta, due: shuffle(due), later: shuffle(later) };
  }, [cards, srs, filterQuery]);

  const current = deck.due[0] || deck.later[0];

  async function getAniListUserId(name) {
    const query = `query($name:String){ User(name:$name){ id name } }`;
    const data = await postJSON(ANILIST_GQL, { query, variables: { name } });
    const u = data?.data?.User;
    if (!u) throw new Error("Utilisateur AniList introuvable");
    return u.id;
  }

  async function getAniListAnime(userId) {
    const query = `query($userId:Int,$page:Int,$perPage:Int){
      Page(page:$page,perPage:$perPage){
        mediaList(userId:$userId,type:ANIME,status_in:[CURRENT,COMPLETED,REPEATING,PAUSED,DROPPED,PLANNING]){
          media{ id title{romaji english native} season seasonYear }
        }
        pageInfo{ hasNextPage }
      }
    }`;
    let page = 1, perPage = 50, out = [];
    while (true) {
      const data = await postJSON(ANILIST_GQL, { query, variables: { userId, page, perPage } });
      const list = data?.data?.Page?.mediaList || [];
      for (const it of list) {
        const m = it.media;
        out.push({
          anilistId: m.id,
          titleRomaji: m.title?.romaji || "",
          titleEnglish: m.title?.english || "",
          titleNative: m.title?.native || "",
          season: m.season || "",
          year: m.seasonYear || null,
        });
      }
      const hasNext = data?.data?.Page?.pageInfo?.hasNextPage;
      if (!hasNext) break;
      page += 1;
      await sleep(400); // be gentle with AniList paging
    }
    return out;
  }

  async function getOpeningsForAniListId(anilistId, titles = {}) {
    // cache
    const cached = cache[String(anilistId)];
    if (cached) return cached;
  
    async function fetchByUrl(url) {
      const data = await fetchJSON(url);
      const animeArr = Array.isArray(data?.anime) ? data.anime : [];
      if (!animeArr.length) return [];
      const a = animeArr[0];
  
      const results = [];
      for (const t of a.animethemes || []) {
        if ((t?.type ?? "").toUpperCase() !== "OP") continue;
  
        const number = t?.sequence ?? null;
        const songTitle = t?.song?.title ?? "";
        let videoUrl = "";
  
        for (const e of t?.animethemeentries || []) {
          const vids = e?.videos || [];
          if (vids.length) {
            videoUrl = vids[0]?.link || vids[0]?.audio || "";
            if (videoUrl) break;
          }
        }
  
        results.push({
          type: "OP",
          number,
          songTitle,
          artists: "",
          videoUrl,
        });
      }
      return results;
    }
  
    // --- On ne tente plus par AniList ID (bug API) ---
    let results = [];
    if (titles?.titleRomaji) {
      results = await fetchByUrl(
        `https://api.animethemes.moe/anime?filter[name]=${encodeURIComponent(
          titles.titleRomaji
        )}&include=animethemes,animethemes.song,animethemes.animethemeentries,animethemes.animethemeentries.videos`
      );
    }
    if (results.length === 0 && titles?.titleEnglish) {
      results = await fetchByUrl(
        `https://api.animethemes.moe/anime?filter[name]=${encodeURIComponent(
          titles.titleEnglish
        )}&include=animethemes,animethemes.song,animethemes.animethemeentries,animethemes.animethemeentries.videos`
      );
    }
    if (results.length === 0 && titles?.titleNative) {
      results = await fetchByUrl(
        `https://api.animethemes.moe/anime?filter[name]=${encodeURIComponent(
          titles.titleNative
        )}&include=animethemes,animethemes.song,animethemes.animethemeentries,animethemes.animethemeentries.videos`
      );
    }
  
    const newCache = { ...cache, [String(anilistId)]: results };
    setCache(newCache);
    return results;
  }
  
  
  
  
  
  
  
  async function buildDeckFromAniList(name) {
    setError("");
    setLoading(true);
    setShowAnswer(false);
    cancelImportRef.current = false;
    idsRef.current = new Set(cards.map(c=>c.id));
    try {
      const uid = await getAniListUserId(name.trim());
      const anime = await getAniListAnime(uid);
      const list = anime.slice(0, Math.max(10, maxShows)); // cap to reduce rate limit hits
      if (list.length === 0) throw new Error("Aucun anime trouvé pour cet utilisateur (profil vide ou privé)");
      setProgress({ totalShows: list.length, processedShows: 0, totalOps: 0 });
      for (const m of list) {
        if (cancelImportRef.current) break;
        try {
          const ops = await getOpeningsForAniListId(m.anilistId, {
            titleRomaji: m.titleRomaji,
            titleEnglish: m.titleEnglish,
            titleNative: m.titleNative,
          });
          let added = 0;
          const newCards = [];
          for (const op of ops) {
            const id = `${m.anilistId}::OP${op.number || 1}`;
            if (!idsRef.current.has(id)) {
              idsRef.current.add(id);
              newCards.push({
                id,
                anilistId: m.anilistId,
                titleRomaji: m.titleRomaji,
                titleEnglish: m.titleEnglish,
                titleNative: m.titleNative,
                season: m.season,
                year: m.year,
                opNumber: op.number,
                songTitle: op.songTitle,
                artists: op.artists,
                videoUrl: op.videoUrl,
              });
              added += 1;
            }
          }
          if (newCards.length) setCards(prev => dedupeById([...(prev || []), ...newCards]));
          setProgress(prev => ({ ...prev, processedShows: prev.processedShows + 1, totalOps: prev.totalOps + added }));
        } catch (e) {
          setProgress(prev => ({ ...prev, processedShows: prev.processedShows + 1 }));
        }
        // polite delay (user‑configurable) to avoid 429
        await sleep(delayMs + Math.floor(Math.random()*JITTER_MS));
      }
      // final dedupe + message explicite si 0 carte
      setCards(prev => {
        const deduped = dedupeById(prev || []);
        if (deduped.length === 0) {
          setError("Aucun OP trouvé via AnimeThemes pour tes séries (le mapping AniList → AnimeThemes a peut-être échoué pour ce compte).");
        }
        return deduped;
    });
    } catch (e) {
      setError(e?.message || String(e));
      setCards([]);
    } finally {
      setLoading(false);
    }
  }

  function grade(quality) {
    if (!current) return;
    const next = sm2Schedule(srs[current.id], quality);
    setSrs(prev => ({ ...prev, [current.id]: next }));
    setShowAnswer(false);
  }

  function resetProgress() {
    if (!confirm("Reset all scheduling data?")) return;
    setSrs({});
  }

  function clearCache() {
    if (!confirm("Effacer le cache local des OP (AnimeThemes)?")) return;
    setCache({});
  }

  function cancelImport() { cancelImportRef.current = true; }

  // ---- Lightweight self-tests (run via Settings) ----
  const [testResults, setTestResults] = useState([]);
  function runSelfTests() {
    const results = [];

    function expect(label, cond) { results.push({ label, pass: !!cond }); }

    // Test 1: SM-2 Again should reset reps and set 10min interval
    const t1 = sm2Schedule({ ef: 2.5, interval: 0, reps: 3, due: 0 }, 0);
    expect("SM2 Again sets 10min", t1.interval === 10*60*1000 && t1.reps === 0 && t1.due > Date.now());

    // Test 2: First learn (reps=0) with Good → 1 day
    const t2 = sm2Schedule({ ef: 2.5, interval: 0, reps: 0, due: 0 }, 2);
    expect("SM2 first Good = 1 day", t2.interval === 24*60*60*1000 && t2.reps === 1);

    // Test 3: Filter hay join produces no newline and lowercase search works
    const demoCard = { titleRomaji: "Naruto", titleEnglish: "Naruto", titleNative: "ナルト", songTitle: "GO!", artists: "FLOW" };
    const hay = [demoCard.titleRomaji, demoCard.titleEnglish, demoCard.titleNative, demoCard.songTitle, demoCard.artists].join(" ").toLowerCase();
    expect("Filter hay join ok", typeof hay === "string" && !/\n/.test(hay) && hay.includes("flow"));

    // Test 4: Incremental dedupe works — adding same id twice keeps one
    const s = new Set();
    const id = "123::OP1";
    const before = s.size; s.add(id); s.add(id);
    expect("Dedup Set keeps one", s.size === before + 1);

    // Test 5: Negative filter case should not match
    expect("Filter negative case", !hay.includes("xyz___unlikely___term"));

    // Test 6: Later reviews grow interval with Good
    const prevInt = 2*24*60*60*1000; // 2 days
    const t6 = sm2Schedule({ ef: 2.5, interval: prevInt, reps: 2, due: 0 }, 2);
    expect("SM2 grows after reps≥2", t6.interval > prevInt);

    setTestResults(results);
  }

  const total = deck.all.length;
  const dueCount = deck.due.length;
  const learned = deck.all.filter(c => (srs[c.id]?.reps || 0) >= 3).length;

  function clearCache() {
    if (!confirm("Effacer le cache local des OP (AnimeThemes)?")) return;
    setCache({});
    localStorage.removeItem("amq_srs_cache_v1");  // <-- purge totale
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">AMQ‑SRS Trainer <span className="text-sm font-normal">(AniList → AnimeThemes → Anki‑style)</span></h1>
          <button className="text-sm underline" onClick={() => setShowSettings(s => !s)}>
            {showSettings ? "Fermer" : "Réglages"}
          </button>
        </header>

        <section className="mb-4 grid md:grid-cols-3 gap-3">
          <div className="md:col-span-2 flex gap-2">
            <input
              className="w-full rounded-2xl border px-4 py-2"
              placeholder="Ton username AniList"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') buildDeckFromAniList(username); }}
            />
            <button
              className="rounded-2xl px-4 py-2 bg-black text-white disabled:opacity-50"
              disabled={!username.trim() || loading}
              onClick={() => buildDeckFromAniList(username)}
            >{loading ? `Import… ${progress.processedShows}/${progress.totalShows}` : "Charger"}</button>
          </div>
          <div className="flex gap-2">
            <input
              className="w-full rounded-2xl border px-4 py-2"
              placeholder="Filtrer (anime / chanson / artiste)"
              value={filterQuery}
              onChange={e => setFilterQuery(e.target.value)}
            />
            <button className="rounded-2xl px-4 py-2 border" onClick={() => setFilterQuery("")}>Clear</button>
          </div>
        </section>

        {/* Progress bar & actions while importing */}
        {loading && (
          <section className="mb-4">
            <div className="mb-2 text-sm text-gray-600 flex items-center justify-between">
              <span>Séries importées : {progress.processedShows} / {progress.totalShows} • OP ajoutés : {progress.totalOps}</span>
              <div className="flex gap-2">
                {cards.length > 0 && (
                  <a href="#review" className="underline text-sm">Commencer à réviser maintenant</a>
                )}
                <button className="text-sm underline" onClick={cancelImport}>Arrêter l'import</button>
              </div>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-gray-800" style={{ width: `${progress.totalShows ? Math.min(100, Math.round(100 * progress.processedShows / progress.totalShows)) : 0}%` }} />
            </div>
          </section>
        )}

        {/* Review Card */}
        <section id="review" className="rounded-2xl border p-4 bg-white shadow-sm">
          {!current && (
            <div className="text-center py-16">
              <div className="text-lg font-semibold">Aucune carte à afficher.</div>
              <div className="text-sm text-gray-600">Charge ta liste AniList pour créer le deck, ou attends que des cartes arrivent à échéance.</div>
            </div>
          )}

          {current && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm text-gray-600">Prochaine échéance: { current.srs?.due && current.srs?.due > now ? new Date(current.srs.due).toLocaleString() : "maintenant" }</div>
                {current.videoUrl ? (
                  <a className="text-sm underline" href={current.videoUrl} target="_blank" rel="noreferrer">Ouvrir la vidéo</a>
                ) : (
                  <span className="text-sm text-gray-400">Pas de lien vidéo</span>
                )}
              </div>

              {current.videoUrl && (
                <div className="mb-2">
                  <button
                    className="text-xs underline"
                    onClick={() => setHideVideo(v => !v)}
                  >
                    {hideVideo ? "Afficher l’image" : "Masquer l’image (garder le son)"}
                  </button>
                </div>
              )}


              {current.videoUrl ? (
                <div
                  className="mb-4"
                  style={{ display: "flex", justifyContent: "center" }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      maxWidth: 720,        // largeur max ~720px
                      aspectRatio: "16 / 9",// ratio stable
                      overflow: "hidden",
                      borderRadius: 12,
                      background: "#000",
                    }}
                  >
                    <video
                      src={current.videoUrl}
                      controls
                      preload="metadata"
                      // Taille vraiment limitée + image masquée via CSS filter (audio reste)
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        // si hideVideo => on noircit l'image (mais le son joue)
                        filter: hideVideo ? "brightness(0) contrast(0)" : "none",
                        zIndex: 0,
                      }}
                    />
                    {/* Masque noir par-dessus (au cas où certains moteurs vidéo superposent encore) */}
                    {hideVideo && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background: "#000",
                          opacity: 1,
                          zIndex: 5,
                          pointerEvents: "none", // on laisse les contrôles cliquables à travers
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
                <input ref={answerRef} className="w-full rounded-2xl border px-4 py-2" placeholder="Tape ta réponse (titre de l'anime)" onKeyDown={(e)=>{ if(e.key==='Enter') setShowAnswer(true); }} />
              </div>

              {!showAnswer ? (
                <div className="flex justify-center">
                  <button className="rounded-2xl px-6 py-2 border" onClick={()=>setShowAnswer(true)}>Révéler</button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-center">
                    <div className="text-xl font-bold">{current.titleRomaji || current.titleEnglish || current.titleNative}</div>
                    <div className="text-sm text-gray-600">OP{current.opNumber || 1} — {current.songTitle || 'Titre inconnu'} {current.artists ? `• ${current.artists}` : ''}</div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 mt-3">
                    <button className="rounded-xl px-3 py-2 bg-red-50 border border-red-200" onClick={()=>grade(0)}>Again</button>
                    <button className="rounded-xl px-3 py-2 bg-yellow-50 border border-yellow-200" onClick={()=>grade(1)}>Hard</button>
                    <button className="rounded-xl px-3 py-2 bg-green-50 border border-green-200" onClick={()=>grade(2)}>Good</button>
                    <button className="rounded-xl px-3 py-2 bg-blue-50 border border-blue-200" onClick={()=>grade(3)}>Easy</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Deck table */}
        <section className="mt-6">
          <div className="text-sm mb-2 text-gray-600">Deck ({deck.all.length})</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-2">Anime</th>
                  <th className="py-2 pr-2">OP</th>
                  <th className="py-2 pr-2">Chanson</th>
                  <th className="py-2 pr-2">Artistes</th>
                  <th className="py-2 pr-2">Échéance</th>
                </tr>
              </thead>
              <tbody>
                {deck.all.map(c => (
                  <tr key={c.id} className="border-b hover:bg-gray-50">
                    <td className="py-2 pr-2">{c.titleRomaji || c.titleEnglish || c.titleNative}</td>
                    <td className="py-2 pr-2">OP{c.opNumber || 1}</td>
                    <td className="py-2 pr-2">{c.songTitle || "—"}</td>
                    <td className="py-2 pr-2">{c.artists || "—"}</td>
                    <td className="py-2 pr-2">{srs[c.id]?.due ? new Date(srs[c.id].due).toLocaleString() : "à réviser"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="mt-8 text-xs text-gray-500">
          <button
            className="rounded-xl px-3 py-2 border text-xs ml-2"
            onClick={clearCache}
          >
            Effacer le cache OP
          </button>
          <p>
            Sources : AniList GraphQL • AnimeThemes.moe. Ce projet n'est affilié ni à AMQ ni à Anki.
          </p>
          <div className="mt-2">
            <button className="rounded-xl px-3 py-2 border text-xs" onClick={runSelfTests}>Exécuter les tests</button>
            {testResults.length > 0 && (
              <ul className="mt-2 list-disc pl-5 space-y-0.5">
                {testResults.map((t,i)=> (
                  <li key={i} className={t.pass ? "text-green-700" : "text-red-700"}>
                    {t.pass ? "✔" : "✘"} {t.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
