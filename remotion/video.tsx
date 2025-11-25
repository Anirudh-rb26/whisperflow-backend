import { registerRoot, Composition, useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion';
import { Html5Video } from 'remotion';
import React from 'react';

// ==================== TYPE DEFINITIONS ====================
// Copy this interface to frontend/app/page.tsx as well to keep in sync
export type CaptionStyles = {
    captionStyle: string;
    captionTextColor: string;
    captionBackgroundColor: string;
    fontFamily: string;
    fontSize: string;
};

interface RemotionCompositionProps {
    src: string;
    srtContent?: string;
    captionStyle?: CaptionStyles;
}

interface ParsedCaption {
    startMs: number;
    endMs: number;
    text: string;
}

interface CaptionOverlayProps {
    srtContent: string;
    captionStyle: CaptionStyles;
}

// ==================== UTILITIES ====================
const fontSizeMap: Record<string, string> = {
    sm: '18px',
    md: '24px',
    lg: '32px',
    xl: '48px',
};

// Inline SRT parser (from @remotion/captions logic)
function parseSrt(input: string): { captions: ParsedCaption[] } {
    const lines = input.trim().split('\n');
    const captions: ParsedCaption[] = [];

    let i = 0;
    while (i < lines.length) {
        // Skip index line
        if (lines[i].trim() && /^\d+$/.test(lines[i].trim())) {
            i++;
        }

        // Parse timestamp line
        if (i < lines.length && lines[i].includes('-->')) {
            const timeMatch = lines[i].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);

            if (timeMatch) {
                const startMs =
                    parseInt(timeMatch[1]) * 3600000 +
                    parseInt(timeMatch[2]) * 60000 +
                    parseInt(timeMatch[3]) * 1000 +
                    parseInt(timeMatch[4]);

                const endMs =
                    parseInt(timeMatch[5]) * 3600000 +
                    parseInt(timeMatch[6]) * 60000 +
                    parseInt(timeMatch[7]) * 1000 +
                    parseInt(timeMatch[8]);

                i++;

                // Collect text lines
                const textLines: string[] = [];
                while (i < lines.length && lines[i].trim() !== '') {
                    textLines.push(lines[i]);
                    i++;
                }

                if (textLines.length > 0) {
                    captions.push({
                        startMs,
                        endMs,
                        text: textLines.join(' ').trim(),
                    });
                }
            }
        }

        i++;
    }

    return { captions };
}

function getLightenedColor(color: string, amount: number = 0.5): string {
    const hex = color.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);

    const newR = Math.round(r + (255 - r) * amount);
    const newG = Math.round(g + (255 - g) * amount);
    const newB = Math.round(b + (255 - b) * amount);

    return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

// ==================== CAPTION OVERLAY COMPONENT ====================
const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
    srtContent,
    captionStyle,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    const currentTimeMs = (frame / fps) * 1000;
    const { captions } = parseSrt(srtContent);

    const activeCaption = captions.find(
        (caption) => currentTimeMs >= caption.startMs && currentTimeMs <= caption.endMs
    );

    if (!activeCaption) {
        return null;
    }

    // Karaoke Style
    const renderKaraokeStyle = () => {
        const words = activeCaption.text.split(' ');
        const captionDuration = activeCaption.endMs - activeCaption.startMs;
        const timePerWord = captionDuration / words.length;
        const elapsedTime = currentTimeMs - activeCaption.startMs;
        const currentWordIndex = Math.floor(elapsedTime / timePerWord);
        const wordProgress = (elapsedTime % timePerWord) / timePerWord;

        const inactiveColor = getLightenedColor(captionStyle.captionTextColor || '#ffffff', 0.65);
        const activeColor = captionStyle.captionTextColor || '#ffffff';

        return (
            <div
                style={{
                    position: 'absolute',
                    bottom: '10%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    backgroundColor: captionStyle.captionBackgroundColor || 'rgba(0, 0, 0, 0.85)',
                    padding: '16px 32px',
                    borderRadius: '12px',
                    fontSize: fontSizeMap[captionStyle.fontSize] || '24px',
                    fontWeight: 'bold',
                    fontFamily: captionStyle.fontFamily || 'sans-serif',
                    textAlign: 'center',
                    maxWidth: '85%',
                    zIndex: 10,
                    display: 'flex',
                    gap: '10px',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                }}
            >
                {words.map((word, index) => {
                    let wordOpacity = 1;
                    let wordScale = 1;
                    let wordColor = inactiveColor;
                    let wordTranslateY = 0;

                    if (index < currentWordIndex) {
                        wordColor = activeColor;
                        wordOpacity = 0.9;
                    } else if (index === currentWordIndex) {
                        wordColor = activeColor;

                        if (wordProgress < 0.3) {
                            wordScale = 1 + (wordProgress / 0.3) * 0.15;
                        } else if (wordProgress > 0.7) {
                            wordScale = 1.15 - ((wordProgress - 0.7) / 0.3) * 0.15;
                        } else {
                            wordScale = 1.15;
                        }

                        if (wordProgress < 0.2) {
                            wordTranslateY = -3 * Math.sin((wordProgress / 0.2) * Math.PI);
                        }

                        wordOpacity = 1;
                    } else {
                        wordOpacity = 0.5;
                    }

                    return (
                        <span
                            key={index}
                            style={{
                                color: wordColor,
                                opacity: wordOpacity,
                                transform: `scale(${wordScale}) translateY(${wordTranslateY}px)`,
                                display: 'inline-block',
                                textShadow:
                                    index === currentWordIndex
                                        ? `0 0 20px ${activeColor}40, 0 2px 4px rgba(0,0,0,0.8)`
                                        : '0 2px 4px rgba(0,0,0,0.6)',
                                filter: index === currentWordIndex ? 'brightness(1.2)' : 'none',
                            }}
                        >
                            {word}
                        </span>
                    );
                })}
            </div>
        );
    };

    // News Style
    const renderNewsStyle = () => {
        const progress = Math.min((currentTimeMs - activeCaption.startMs) / 300, 1);
        const slideAmount = (1 - progress) * -100;

        return (
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    backgroundColor: captionStyle.captionBackgroundColor || 'rgba(200, 0, 0, 0.9)',
                    color: captionStyle.captionTextColor || 'white',
                    padding: '16px 24px',
                    fontSize: fontSizeMap[captionStyle.fontSize] || '24px',
                    fontWeight: 'bold',
                    fontFamily: captionStyle.fontFamily || 'sans-serif',
                    textAlign: 'center',
                    zIndex: 10,
                    transform: `translateY(${slideAmount}%)`,
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)',
                    borderBottom: `3px solid ${captionStyle.captionTextColor || 'white'}`,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                    <span style={{ paddingLeft: '12px' }}>{activeCaption.text}</span>
                </div>
            </div>
        );
    };

    // Standard Style
    const renderStandardStyle = () => {
        const progress = Math.min((currentTimeMs - activeCaption.startMs) / 200, 1);
        const opacity = progress;
        const scale = 0.9 + progress * 0.1;

        return (
            <div
                style={{
                    position: 'absolute',
                    bottom: '10%',
                    left: '50%',
                    transform: `translateX(-50%) scale(${scale})`,
                    backgroundColor: captionStyle.captionBackgroundColor || 'rgba(0, 0, 0, 0.8)',
                    color: captionStyle.captionTextColor || 'white',
                    padding: '12px 24px',
                    borderRadius: '8px',
                    fontSize: fontSizeMap[captionStyle.fontSize] || '24px',
                    fontWeight: 'bold',
                    fontFamily: captionStyle.fontFamily || 'sans-serif',
                    textAlign: 'center',
                    maxWidth: '80%',
                    zIndex: 10,
                    opacity: opacity,
                }}
            >
                {activeCaption.text}
            </div>
        );
    };

    switch (captionStyle.captionStyle) {
        case 'Karaoke Style':
            return renderKaraokeStyle();
        case 'News Style (Top Bar)':
            return renderNewsStyle();
        case 'Standard (Bottom Centered)':
        default:
            return renderStandardStyle();
    }
};

// ==================== MAIN VIDEO COMPOSITION ====================
const VideoComposition: React.FC<RemotionCompositionProps> = ({ src, srtContent, captionStyle }) => {
    return (
        <AbsoluteFill style={{ backgroundColor: '#000' }}>
            <Html5Video src={src} style={{ width: '100%', height: '100%' }} />
            {srtContent && captionStyle && <CaptionOverlay srtContent={srtContent} captionStyle={captionStyle} />}
        </AbsoluteFill>
    );
};

// ==================== ROOT REGISTRATION ====================
export const RemotionRoot: React.FC = () => (
    <Composition
        id="MyRemotionComposition"
        component={VideoComposition}
        durationInFrames={1800}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
            src: '',
            srtContent: undefined,
            captionStyle: undefined,
        }}
    />
);

registerRoot(RemotionRoot);
export default RemotionRoot;