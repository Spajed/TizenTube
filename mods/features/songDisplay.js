// Song display: switch music videos between the video, the song artwork and synced lyrics.
// https://github.com/reisxd/TizenTubeCobalt/issues/301

import { configRead, configWrite, configChangeEmitter } from '../config.js';
import { showModal, buttonItem, overlayPanelItemListRenderer } from '../ui/ytUI.js';
import { fetchLyrics, getSongInfo } from '../utils/lyricsProviders.js';
import { t } from 'i18next';

const MODES = ['video', 'artwork', 'lyrics'];
const MODE_ICONS = {
    video: 'VIDEO_YOUTUBE',
    artwork: 'YOUTUBE_MUSIC',
    lyrics: 'MENU'
};

const WORD_UPCOMING = 0;
const WORD_ACTIVE = 1;
const WORD_SUNG = 2;
const WORD_CLASSES = [
    'tt-song-display-word',
    'tt-song-display-word tt-song-display-word-active',
    'tt-song-display-word tt-song-display-word-sung'
];

const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'timeupdate'];
const MAX_REMEMBERED_VIDEOS = 100;

// videoDetails of the player responses, used to tell music apart from other videos.
const videoDetails = new Map();
const elements = {};
const state = {
    visible: false,
    mode: 'video',
    videoId: null,
    lyricsVideoId: null,
    lyrics: null,
    lines: [],
    activeLine: -1,
    wordSync: false,
    video: null,
    frame: null,
    retryTimeout: null
};

export function rememberVideoDetails(details) {
    if (videoDetails.size >= MAX_REMEMBERED_VIDEOS) videoDetails.delete(videoDetails.keys().next().value);
    videoDetails.set(details.videoId, Object.assign({}, videoDetails.get(details.videoId), details));

    if (details.videoId !== getWatchVideoId()) return;
    setTimeout(() => {
        if (state.videoId === details.videoId) renderSongInfo(details.videoId);
        update();
    }, 0);
}

export function isCurrentVideoMusic() {
    return isMusic(getWatchVideoId());
}

export function showSongDisplayModes() {
    const currentMode = configRead('songDisplayMode');
    const buttons = MODES.map((mode) => buttonItem(
        { title: t(`player.songDisplay.modes.${mode}`) },
        {
            icon: MODE_ICONS[mode],
            secondaryIcon: mode === currentMode ? 'RADIO_BUTTON_CHECKED' : 'RADIO_BUTTON_UNCHECKED'
        },
        [
            {
                signalAction: {
                    signal: 'POPUP_BACK'
                }
            },
            {
                customAction: {
                    action: 'SET_SONG_DISPLAY_MODE',
                    parameters: mode
                }
            }
        ]
    ));

    showModal(t('player.songDisplay.title'), overlayPanelItemListRenderer(buttons, Math.max(MODES.indexOf(currentMode), 0)), 'tt-song-display');
}

export function setSongDisplayMode(mode) {
    if (MODES.indexOf(mode) === -1) return;
    configWrite('songDisplayMode', mode);
}

function getWatchVideoId() {
    const hash = location.hash.substring(1);
    if (hash.indexOf('/watch') !== 0) return null;
    const match = hash.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
}

function isMusic(videoId) {
    const details = videoDetails.get(videoId);
    return !!details && !!details.musicVideoType && details.musicVideoType !== 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE';
}

function getDetails(videoId) {
    const details = Object.assign({ videoId }, videoDetails.get(videoId));
    if (!details.title || !details.author) {
        try {
            const videoData = document.querySelector('.html5-video-player').getVideoData();
            if (videoData && videoData.video_id === videoId) {
                details.title = details.title || videoData.title;
                details.author = details.author || videoData.author;
            }
        } catch (e) { }
    }
    return details;
}

function update() {
    clearTimeout(state.retryTimeout);

    const videoId = getWatchVideoId();
    const mode = configRead('songDisplayMode');
    if (!videoId || window.isPipPlaying || mode === 'video' || !isMusic(videoId)) {
        hide();
        return;
    }

    const player = document.querySelector('.html5-video-player');
    if (!player) {
        state.retryTimeout = setTimeout(update, 500);
        return;
    }

    const root = getOverlay();
    if (root.parentNode !== player) player.appendChild(root);

    if (state.videoId !== videoId) {
        if (state.lyricsVideoId !== videoId) clearLyrics();
        state.videoId = videoId;
        renderSongInfo(videoId);
        setArtwork(videoId);
    }

    if (mode === 'lyrics' && state.lyricsVideoId !== videoId) loadLyrics(videoId);

    state.mode = mode;
    state.wordSync = !!state.lyrics && state.lyrics.synced === 'word' && configRead('enableWordSyncedLyrics');
    root.className = `tt-song-display tt-song-display-${mode}-mode`
        + (state.wordSync ? ' tt-song-display-word-sync' : '')
        + (state.lyrics && state.lyrics.synced === 'none' ? ' tt-song-display-plain' : '');
    root.style.display = 'block';
    state.visible = true;

    attachVideo();
    syncLyrics();
    // The lyrics can't be measured while hidden, so line up the scroll position again once they are shown.
    if (mode === 'lyrics' && state.lyrics && state.lyrics.synced !== 'none') scrollToLine(state.activeLine);
    startLoop();
}

function hide() {
    if (!state.visible) return;
    state.visible = false;
    stopLoop();
    elements.root.style.display = 'none';
}

function getOverlay() {
    if (elements.root) return elements.root;

    const create = (className, parent) => {
        const element = document.createElement('div');
        element.className = className;
        if (parent) parent.appendChild(element);
        return element;
    };

    elements.root = create('tt-song-display');
    elements.background = create('tt-song-display-background', elements.root);
    const content = create('tt-song-display-content', elements.root);
    const info = create('tt-song-display-info', content);
    elements.artwork = create('tt-song-display-artwork', info);
    elements.title = create('tt-song-display-title', info);
    elements.artist = create('tt-song-display-artist', info);
    elements.source = create('tt-song-display-source', info);
    elements.lyrics = create('tt-song-display-lyrics', content);
    elements.lyricsScroll = create('tt-song-display-lyrics-scroll', elements.lyrics);
    elements.message = create('tt-song-display-message', elements.lyrics);
    return elements.root;
}

function renderSongInfo(videoId) {
    const song = getSongInfo(getDetails(videoId));
    elements.title.textContent = song.title;
    elements.artist.textContent = song.artist;
}

function setArtwork(videoId) {
    // hqdefault.jpg always exists, maxresdefault.jpg replaces it once loaded if the video has one.
    showArtwork(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, true);

    const image = new Image();
    image.onload = () => {
        // A missing maxresdefault.jpg is served as a 120x90 placeholder.
        if (state.videoId === videoId && image.naturalWidth > 120) showArtwork(image.src, false);
    };
    image.src = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

function showArtwork(url, letterboxed) {
    elements.artwork.style.backgroundImage = `url("${url}")`;
    // hqdefault.jpg is 4:3 with the 16:9 frame letterboxed into it, zoom in past the black bars.
    elements.artwork.style.backgroundSize = letterboxed ? 'auto 133.4%' : 'cover';
    elements.background.style.backgroundImage = `url("${url}")`;
}

function showMessage(text) {
    elements.message.textContent = text;
    elements.message.style.display = text ? 'block' : 'none';
}

function clearLyrics() {
    state.lyricsVideoId = null;
    state.lyrics = null;
    state.lines = [];
    state.activeLine = -1;
    elements.lyricsScroll.textContent = '';
    elements.lyricsScroll.style.transform = '';
    elements.source.textContent = '';
    showMessage('');
}

function loadLyrics(videoId) {
    showMessage(t('player.songDisplay.loading'));

    const song = getSongInfo(getDetails(videoId));
    // Without a title there is nothing to search for yet, wait for the video details to arrive.
    if (!song.title) return;

    state.lyricsVideoId = videoId;
    fetchLyrics(videoId, song).then((lyrics) => {
        if (state.lyricsVideoId !== videoId) return;

        if (!lyrics) {
            showMessage(t('player.songDisplay.notFound'));
        } else if (lyrics.instrumental) {
            showMessage(t('player.songDisplay.instrumental'));
        } else {
            showMessage('');
            renderLyrics(lyrics);
        }
        update();
    });
}

function renderLyrics(lyrics) {
    state.lyrics = lyrics;
    state.lines = lyrics.lines.map((line) => {
        const element = document.createElement('div');
        element.className = 'tt-song-display-line';

        const words = appendWords(element, line.words, line.backgroundWords.length ? '' : line.text);
        if (line.backgroundWords.length) {
            const background = document.createElement('div');
            background.className = 'tt-song-display-line-background';
            element.appendChild(background);
            words.push.apply(words, appendWords(background, line.backgroundWords, ''));
        }
        // Keep empty lines of unsynced lyrics as verse breaks.
        if (!element.firstChild) element.textContent = ' ';

        elements.lyricsScroll.appendChild(element);
        return { element, start: line.start, end: line.end, words };
    });
    elements.source.textContent = t('player.songDisplay.source', { source: lyrics.source });
}

function appendWords(parent, words, text) {
    if (!words.length) {
        if (text) parent.appendChild(document.createTextNode(text));
        return [];
    }

    return words.map((word) => {
        const element = document.createElement('span');
        element.className = WORD_CLASSES[WORD_UPCOMING];
        element.textContent = word.text;
        parent.appendChild(element);
        return { element, start: word.start, end: word.end, state: WORD_UPCOMING };
    });
}

function syncLyrics() {
    if (!state.visible || state.mode !== 'lyrics' || !state.lyrics || !state.video) return;

    const time = state.video.currentTime;
    if (state.lyrics.synced === 'none') {
        scrollPlainLyrics(time);
        return;
    }

    let active = -1;
    while (active + 1 < state.lines.length && state.lines[active + 1].start <= time) active++;

    if (active !== state.activeLine) {
        const previous = state.lines[state.activeLine];
        if (previous) {
            previous.element.classList.remove('tt-song-display-line-active');
            previous.words.forEach((word) => setWordState(word, WORD_UPCOMING));
        }

        state.activeLine = active;
        if (state.lines[active]) state.lines[active].element.classList.add('tt-song-display-line-active');
        scrollToLine(active);
    }

    if (state.wordSync && state.lines[active]) {
        for (const word of state.lines[active].words) {
            if (time >= word.end) setWordState(word, WORD_SUNG);
            else if (time >= word.start) setWordState(word, WORD_ACTIVE, (time - word.start) / (word.end - word.start));
            else setWordState(word, WORD_UPCOMING);
        }
    }
}

function setWordState(word, wordState, progress) {
    if (word.state !== wordState) {
        word.state = wordState;
        word.element.className = WORD_CLASSES[wordState];
        if (wordState !== WORD_ACTIVE) word.element.style.backgroundPosition = '';
    }

    if (wordState === WORD_ACTIVE) {
        // The highlight gradient is twice as wide as the word, sliding it left fills the word up.
        word.element.style.backgroundPosition = `${100 - Math.round(progress * 100)}% 0`;
    }
}

function scrollToLine(index) {
    // Before the first line starts, show it as the upcoming line.
    const line = state.lines[Math.max(index, 0)];
    if (!line) return;
    // Keep the active line above the middle, the player controls cover the bottom of the screen.
    const offset = line.element.offsetTop + line.element.offsetHeight / 2 - elements.lyrics.offsetHeight * 0.4;
    elements.lyricsScroll.style.transform = `translateY(${-offset}px)`;
}

function scrollPlainLyrics(time) {
    // Unsynced lyrics scroll along with the playback progress.
    const overflow = elements.lyricsScroll.offsetHeight - elements.lyrics.offsetHeight;
    const progress = state.video.duration ? Math.min(time / state.video.duration, 1) : 0;
    elements.lyricsScroll.style.transform = `translateY(${-Math.max(overflow, 0) * progress}px)`;
}

function startLoop() {
    if (state.frame || !state.video || state.video.paused) return;

    state.frame = requestAnimationFrame(function loop() {
        state.frame = null;
        if (!state.visible || state.mode !== 'lyrics' || !state.lyrics || state.video.paused) return;
        syncLyrics();
        state.frame = requestAnimationFrame(loop);
    });
}

function stopLoop() {
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = null;
}

function attachVideo() {
    const video = document.querySelector('video');
    if (video === state.video) return;

    if (state.video) VIDEO_EVENTS.forEach((event) => state.video.removeEventListener(event, onVideoEvent));
    state.video = video;
    if (video) VIDEO_EVENTS.forEach((event) => video.addEventListener(event, onVideoEvent));
}

function onVideoEvent(event) {
    // Playback starting is also a good moment to check the overlay is still in place.
    if (event.type === 'play') {
        update();
        return;
    }
    syncLyrics();
    startLoop();
}

window.addEventListener('hashchange', update);

configChangeEmitter.addEventListener('configChange', (event) => {
    if (event.detail.key === 'songDisplayMode' || event.detail.key === 'enableWordSyncedLyrics') update();
});
