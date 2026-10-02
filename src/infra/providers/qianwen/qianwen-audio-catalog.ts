// ------------------------------------------------------------------------
// 名称：qianwen-audio-catalog.ts
// 说明：千问AI平台音频模型目录：音频生成（语音、音效、环境音）与 Fun-Music 音乐生成两个模型的能力描述，以及各模型的接口路径与专有参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：数值来自千问AI平台文档“音频生成 API参考”“音乐生成（Fun-Music）”；Fun-Music 处于邀测阶段，需在平台模型市场申请开通后才能调用。
// ------------------------------------------------------------------------

import { AudioCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor } from '../../../domain/models/model-provider';
import { ExtraParamSpec } from './qianwen-protocol';

/** 单段参考音频的大小上限，单位为字节。 */
export const AUDIO_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

/** 音频生成在提示词中引用第一段参考音频的写法。 */
export const FIRST_VOICE_MARK = '@voice1';

/** 音频生成接口的接口协议：语音（音频生成）与音乐。 */
export type QianwenAudioProtocol = 'speech' | 'music';

/** 各协议的接口路径；两个接口都是同步的，响应里直接带音频下载地址。 */
export const AUDIO_PROTOCOL_PATHS: Readonly<Record<QianwenAudioProtocol, string>> = {
  speech: '/services/audio/tts/SpeechSynthesizer',
  music: '/services/audio/music/generation'
};

/** 一个音频模型的声明及其接口差异。 */
export interface QianwenAudioModel {
  readonly descriptor: ModelDescriptor<'audio'>;
  readonly protocol: QianwenAudioProtocol;
  /** 模型专有参数，写入请求体的 input。 */
  readonly extraParams: Readonly<Record<string, ExtraParamSpec>>;
}

/** 音频生成：中英文语音与音效，单次最长 120 秒（播客 240 秒），提示词最多 3000 字符，可带参考音频。 */
const SPEECH_CAPABILITY: AudioCapability = {
  audioKinds: ['voice', 'sfx'],
  duration: { max: 120 },
  languages: ['zh', 'en'],
  voices: [],
  referenceAudio: true,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: 3000
};

/** Fun-Music：中英文歌曲或纯音乐，提示词最多 2000 字符，不支持参考音频。 */
const MUSIC_CAPABILITY: AudioCapability = {
  audioKinds: ['music'],
  duration: {},
  languages: ['zh', 'en'],
  voices: [],
  referenceAudio: false,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: 2000
};

/** 千问AI平台提供的音频模型。 */
export const QIANWEN_AUDIO_MODELS: readonly QianwenAudioModel[] = [
  {
    descriptor: { code: 'qwen-audio-3.1-tts-next', displayName: '千问音频 3.1（语音与音效）', kind: 'audio', capability: SPEECH_CAPABILITY },
    protocol: 'speech',
    extraParams: { format: { apiKey: 'format', allowed: ['wav', 'mp3'] } }
  },
  {
    descriptor: { code: 'fun-music-v1', displayName: 'Fun-Music 音乐生成（需申请开通）', kind: 'audio', capability: MUSIC_CAPABILITY },
    protocol: 'music',
    extraParams: {
      format: { apiKey: 'format', allowed: ['mp3', 'wav'] },
      instrumental: { apiKey: 'is_instrumental', allowed: [true, false] },
      gender: { apiKey: 'gender', allowed: ['female', 'male'] }
    }
  }
];
