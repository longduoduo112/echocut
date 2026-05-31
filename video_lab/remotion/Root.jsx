import React from 'react';
import { Composition } from 'remotion';
import { CaptionVideo } from './CaptionVideo';

const defaultProps = {
    headline: '用系统替代体力',
    subline: '把经验沉淀成可复制资产',
    audioSrc: '',
    captions: [{ text: '欢迎来到智能视频实验室', startSec: 0, endSec: 3 }]
};

export const RemotionRoot = () => {
    return (
        <Composition
            id="AlexCaptionVideo"
            component={CaptionVideo}
            width={1920}
            height={1080}
            fps={30}
            durationInFrames={450}
            defaultProps={defaultProps}
            calculateMetadata={({ props }) => {
                const end = Array.isArray(props.captions)
                    ? props.captions.reduce((max, item) => Math.max(max, Number(item.endSec || 0)), 0)
                    : 0;
                const duration = Math.max(180, Math.ceil(end * 30) + 45);
                return { durationInFrames: duration };
            }}
        />
    );
};
