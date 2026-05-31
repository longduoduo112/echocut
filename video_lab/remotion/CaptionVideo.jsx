import React from 'react';
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

const backgroundStyle = {
    background: 'radial-gradient(circle at 15% -20%, #20305a 0%, #090d18 45%, #06080f 100%)',
    color: '#f3f6ff',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, sans-serif'
};

const panelStyle = {
    width: '86%',
    maxWidth: 1460,
    borderRadius: 28,
    border: '1px solid rgba(151, 168, 205, 0.22)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
    backdropFilter: 'blur(10px)',
    padding: '32px 36px'
};

const badgeStyle = {
    padding: '8px 14px',
    borderRadius: 999,
    border: '1px solid rgba(151,168,205,0.35)',
    fontSize: 22,
    letterSpacing: 0.3,
    color: '#b9cbf7'
};

const titleStyle = {
    marginTop: 24,
    fontSize: 64,
    lineHeight: 1.1,
    fontWeight: 700
};

const subtitleStyle = {
    marginTop: 18,
    fontSize: 36,
    lineHeight: 1.35,
    color: '#dce6ff'
};

const footerStyle = {
    marginTop: 30,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#9fb3de',
    fontSize: 24
};

const progressOuterStyle = {
    marginTop: 24,
    height: 8,
    width: '100%',
    borderRadius: 999,
    background: 'rgba(151, 168, 205, 0.2)'
};

function getActiveCaption(captions, t) {
    if (!Array.isArray(captions) || !captions.length) return null;
    for (const caption of captions) {
        if (t >= caption.startSec && t <= caption.endSec) return caption;
    }
    return captions[captions.length - 1];
}

function getCaptionEnter(frame, fps, active) {
    if (!active) return { y: 0, scale: 1, glow: 0.2 };
    const startFrame = Math.max(0, Math.floor(active.startSec * fps));
    const localFrame = Math.max(0, frame - startFrame);
    const p = spring({
        frame: localFrame,
        fps,
        config: { damping: 17, stiffness: 180, mass: 0.7 }
    });
    return {
        y: interpolate(p, [0, 1], [24, 0]),
        scale: interpolate(p, [0, 1], [0.96, 1]),
        glow: interpolate(p, [0, 1], [0.25, 0.55]),
        bg: interpolate(p, [0, 1], [0.15, 0.32])
    };
}

function splitCaptionTerms(text) {
    const source = String(text || '').trim();
    if (!source) return [];
    if (source.includes(' ')) return source.split(/\s+/).filter(Boolean);
    const chars = Array.from(source);
    const terms = [];
    let buf = '';
    for (const ch of chars) {
        if (/[，。！？；：,.!?;:、]/.test(ch)) {
            if (buf) terms.push(buf);
            terms.push(ch);
            buf = '';
            continue;
        }
        buf += ch;
        if (buf.length >= 3) {
            terms.push(buf);
            buf = '';
        }
    }
    if (buf) terms.push(buf);
    return terms;
}

function isEmphasisTerm(term, emphasisWords, emphasisEnabled) {
    if (!emphasisEnabled) return false;
    if (!Array.isArray(emphasisWords) || !emphasisWords.length) return false;
    return emphasisWords.some((w) => term.includes(w));
}

function resolveAudioSrc(audioSrc) {
    const source = String(audioSrc || '').trim();
    if (!source) return '';
    if (/^https?:\/\//i.test(source)) return source;
    if (source.startsWith('/')) return source;
    return staticFile(source.replace(/^\/+/, ''));
}

export const CaptionVideo = ({ captions, headline, subline, audioSrc, emphasisWords, emphasisColor = '#FFD54F', emphasisEnabled = true }) => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const t = frame / fps;
    const active = getActiveCaption(captions, t);
    const intro = spring({
        frame,
        fps,
        config: { damping: 200, stiffness: 120 }
    });
    const opacity = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: 'clamp' });
    const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: 'clamp' });
    const captionEnter = getCaptionEnter(frame, fps, active);
    const terms = splitCaptionTerms(active?.text || subline);
    const activeStartFrame = active ? Math.max(0, Math.floor(active.startSec * fps)) : 0;
    const resolvedAudioSrc = resolveAudioSrc(audioSrc);

    return (
        <AbsoluteFill style={{ ...backgroundStyle, justifyContent: 'center', alignItems: 'center', opacity }}>
            {resolvedAudioSrc ? <Audio src={resolvedAudioSrc} delayRenderTimeoutInMilliseconds={120000} /> : null}
            <div style={{ ...panelStyle, transform: `scale(${0.96 + intro * 0.04})` }}>
                <div style={badgeStyle}>echocut · AI CLIP STUDIO</div>
                <div style={titleStyle}>{headline}</div>
                <div
                    style={{
                        ...subtitleStyle,
                        display: 'inline-block',
                        padding: '12px 18px',
                        borderRadius: 14,
                        border: '1px solid rgba(129,140,248,0.45)',
                        background: `rgba(15,23,42,${captionEnter.bg})`,
                        transform: `translateY(${captionEnter.y}px) scale(${captionEnter.scale})`,
                        textShadow: `0 0 24px rgba(96,165,250,${captionEnter.glow})`
                    }}
                >
                    {terms.map((term, idx) => {
                        const rise = spring({
                            frame: Math.max(0, frame - activeStartFrame - idx * 2),
                            fps,
                            config: { damping: 16, stiffness: 190, mass: 0.65 }
                        });
                        const isEmphasis = isEmphasisTerm(term, emphasisWords, emphasisEnabled);
                        const color = isEmphasis ? emphasisColor : '#E6EEFF';
                        const glow = isEmphasis ? 0.78 : 0.38;
                        return (
                            <span
                                key={`${term}_${idx}`}
                                style={{
                                    display: 'inline-block',
                                    marginRight: 8,
                                    transform: `translateY(${interpolate(rise, [0, 1], [10, 0])}px) scale(${interpolate(rise, [0, 1], [0.92, 1])})`,
                                    color,
                                    textShadow: `0 0 22px rgba(245, 158, 11, ${glow})`,
                                    fontWeight: isEmphasis ? 700 : 500
                                }}
                            >
                                {term}
                            </span>
                        );
                    })}
                </div>
                <div style={progressOuterStyle}>
                    <div
                        style={{
                            width: `${progress * 100}%`,
                            height: '100%',
                            borderRadius: 999,
                            background: 'linear-gradient(90deg, #60a5fa 0%, #8b5cf6 100%)'
                        }}
                    />
                </div>
                <div style={footerStyle}>
                    <span>实时字幕驱动 · Remotion</span>
                    <span>{active ? `${active.startSec.toFixed(1)}s - ${active.endSec.toFixed(1)}s` : '--'}</span>
                </div>
            </div>
        </AbsoluteFill>
    );
};
