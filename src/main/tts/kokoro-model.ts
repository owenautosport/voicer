import type { Clip, Synth } from './kokoro'
import type { KokoroDtype } from '../../shared/voices'

/** Kokoro 82M, as ONNX weights the JavaScript runtime can load directly. */
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'

export type ModelOptions = {
  voice: string
  dtype: KokoroDtype
  /** Where the weights live between launches. */
  cacheDir: string
  /** Progress worth putting in front of the user — a download, and nothing else. */
  onStatus?: (text: string) => void
}

type Loaded = { generate(text: string, opts: { voice: string }): Promise<{
  audio: Float32Array
  sampling_rate: number
}> }

/**
 * The bridge to the model itself, kept apart from `KokoroBackend` so that the
 * queueing, the WAV wrapping and the aborts can all be tested without several
 * hundred megabytes of weights being involved.
 *
 * Loading is deferred and shared: whoever asks first pays for it, everyone
 * after that waits on the same promise, and `warm()` exists so that in practice
 * the one who pays is the launch rather than the first thing you say.
 */
export function createKokoroSynth(opts: ModelOptions): { synth: Synth; warm: () => void } {
  let loading: Promise<Loaded> | undefined

  const load = (): Promise<Loaded> => {
    /*
     * Shared, but a failure is not remembered. Loading this the first time can
     * mean a few hundred megabytes over the network, and a connection that
     * drops halfway should cost that attempt rather than the voice for the
     * rest of the session.
     */
    if (loading) return loading

    loading = (async () => {
      // Worth a line in the log: everything downstream of a model that failed
      // to load looks like "the good voice just stopped working".
      const started = Date.now()
      console.log(`[kokoro] loading ${opts.dtype} ${opts.voice} from ${opts.cacheDir}`)
      const { env } = await import('@huggingface/transformers')
      /*
       * Left alone, transformers.js caches the weights inside its own directory
       * under node_modules — which is read-only inside a signed .app, and would
       * be thrown away by every update even where it is not. They belong beside
       * the rest of Voicer's state.
       */
      env.cacheDir = opts.cacheDir

      const { KokoroTTS } = await import('kokoro-js')
      let announced = -1
      const model = await KokoroTTS.from_pretrained(REPO, {
        dtype: opts.dtype,
        device: 'cpu',
        progress_callback: (p: { status?: string; progress?: number }) => {
          // Only the download is worth saying out loud, and only in whole tens:
          // it is a few hundred megabytes once, and then never again.
          if (p.status !== 'progress' || typeof p.progress !== 'number') return
          const step = Math.floor(p.progress / 10) * 10
          if (step <= announced) return
          announced = step
          opts.onStatus?.(`Fetching the ${opts.voice} voice — ${step}%`)
        },
      })
      if (announced >= 0) opts.onStatus?.('')
      console.log(`[kokoro] ready in ${Date.now() - started}ms`)
      return model as unknown as Loaded
    })()
    loading.catch(() => { loading = undefined })
    return loading
  }

  return {
    warm: () => { void load().catch((err) => console.error('[kokoro] could not load:', err)) },
    /*
     * The signal is not passed on. An inference that has started cannot be
     * stopped part-way, so an abort is honoured by throwing the audio away
     * rather than by not making it — see KokoroBackend.
     */
    synth: async (text: string): Promise<Clip> => {
      const model = await load()
      const spoken = await model.generate(text, { voice: opts.voice })
      return { audio: spoken.audio, sampleRate: spoken.sampling_rate }
    },
  }
}
