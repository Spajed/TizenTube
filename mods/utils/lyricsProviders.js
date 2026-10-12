// Lyrics lookup for the song display.
// LyricsPlus (https://github.com/ibratabian17/YouLyPlus) provides word-synced lyrics,
// LRCLIB (https://lrclib.net) is used as a fallback for line-synced and plain lyrics.

import { configRead } from '../config.js';

const LYRICS_PLUS_API = 'https://lyricsplus.binimum.org/v2/lyrics/get';
const LRCLIB_API = 'https://lrclib.net/api/search';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_CACHED_SONGS = 50;

const cache = new Map();

// Words that only describe the upload, not the song, e.g. "(Official Music Video)" or "[HD]".
const TITLE_NOISE = /\s*[\(\[【][^\)\]】]*\b(official|video|audio|lyrics?|visuali[sz]er|mv|m\/v|hd|hq|4k|remaster(ed)?|explicit|feat|ft)\b[^\)\]】]*[\)\]】]/gi;

export function getSongInfo(details) {
    const isArtTrack = details.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV';
    let title = details.title || '';
    let artist = (details.author || '').replace(/\s+-\s+Topic$/i, '').replace(/VEVO$/i, '').trim();

    // Music videos are usually titled "Artist - Song (Official Video)",
    // art tracks already have the plain song title.
    const separator = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (separator && !isArtTrack) {
        artist = separator[1].trim();
        title = separator[2];
    }

    title = title
        .replace(TITLE_NOISE, '')
        .replace(/\s+-\s+.*\bremaster(ed)?\b.*$/i, '')
        .replace(/\s+(feat|ft)\.?\s.*$/i, '')
        .replace(/\s*\|.*$/, '')
        .replace(/\s+m\/?v$/i, '')
        .replace(/["“”]/g, '')
        .trim();

    return {
        title,
        artist,
        duration: Number(details.lengthSeconds) || 0,
        isArtTrack
    };
}

export function fetchLyrics(videoId, song) {
    if (!cache.has(videoId)) {
        if (cache.size >= MAX_CACHED_SONGS) cache.delete(cache.keys().next().value);

        const lyricsPlus = configRead('enableLyricsPlus') ? fetchLyricsPlus(song) : Promise.resolve(null);
        cache.set(videoId, lyricsPlus.then((lyrics) => lyrics || fetchLrclib(song)));
    }
    return cache.get(videoId);
}

function fetchJSON(url, headers) {
    // AbortController isn't available on older Tizen browsers, so race the request against a timer.
    return Promise.race([
        fetch(url, { headers: headers || {} }).then((res) => res.ok ? res.json() : null),
        new Promise((resolve) => setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS))
    ]).catch((err) => {
        console.warn('TizenTube: lyrics request failed:', err);
        return null;
    });
}

function query(params) {
    return Object.keys(params)
        .filter((key) => params[key])
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        .join('&');
}

function fetchLyricsPlus(song) {
    const attempt = (duration) => fetchJSON(`${LYRICS_PLUS_API}?${query({
        title: song.title,
        artist: song.artist,
        duration
    })}`).then(parseLyricsPlus);

    return attempt(song.duration).then((lyrics) => {
        // Music videos often run longer than the song itself, so retry without the duration.
        if (lyrics || song.isArtTrack || !song.duration) return lyrics;
        return attempt(0);
    });
}

function parseLyricsPlus(data) {
    if (!data || !Array.isArray(data.lyrics) || !data.lyrics.length) return null;

    const synced = data.type === 'Word' ? 'word' : data.type === 'Line' ? 'line' : 'none';
    const toWord = (syllable) => ({
        start: syllable.time / 1000,
        end: (syllable.time + syllable.duration) / 1000,
        text: syllable.text
    });

    return {
        synced,
        source: 'LyricsPlus',
        lines: data.lyrics.map((line) => {
            const syllables = synced === 'word' && Array.isArray(line.syllabus) ? line.syllabus : [];
            return {
                start: line.time / 1000,
                end: (line.time + line.duration) / 1000,
                text: line.text || '',
                words: syllables.filter((syllable) => !syllable.isBackground).map(toWord),
                backgroundWords: syllables.filter((syllable) => syllable.isBackground).map(toWord)
            };
        })
    };
}

function fetchLrclib(song) {
    return fetchJSON(`${LRCLIB_API}?${query({ track_name: song.title, artist_name: song.artist })}`, {
        'Lrclib-Client': 'TizenTube (https://github.com/reisxd/TizenTube)'
    }).then((results) => {
        if (!Array.isArray(results) || !results.length) return null;

        // Prefer synced lyrics, then the closest duration.
        const score = (result) => (song.duration ? Math.abs(result.duration - song.duration) : 0) + (result.syncedLyrics ? 0 : 30);
        const best = results.slice().sort((a, b) => score(a) - score(b))[0];

        // Art tracks have the exact song duration, anything further off is likely another recording.
        if (song.isArtTrack && song.duration && Math.abs(best.duration - song.duration) > 5) return null;

        return parseLrclib(best);
    });
}

function parseLrclib(result) {
    if (result.instrumental) {
        return { synced: 'none', source: 'LRCLIB', instrumental: true, lines: [] };
    }

    if (result.syncedLyrics) {
        const lines = [];
        for (const row of result.syncedLyrics.split('\n')) {
            const times = [];
            const text = row.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, (_, minutes, seconds) => {
                times.push(Number(minutes) * 60 + Number(seconds));
                return '';
            }).trim();

            for (const start of times) {
                lines.push({ start, text: text || '♪', words: [], backgroundWords: [] });
            }
        }

        lines.sort((a, b) => a.start - b.start);
        lines.forEach((line, i) => {
            line.end = lines[i + 1] ? lines[i + 1].start : line.start + 5;
        });

        if (lines.length) return { synced: 'line', source: 'LRCLIB', lines };
    }

    if (result.plainLyrics) {
        return {
            synced: 'none',
            source: 'LRCLIB',
            lines: result.plainLyrics.split('\n').map((text) => ({ start: 0, end: 0, text, words: [], backgroundWords: [] }))
        };
    }

    return null;
}
