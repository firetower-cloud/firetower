/**
 * Saying a message instead of typing it.
 *
 * Transcribed **on the device**. That is the only reason this is in the app at
 * all rather than left to the keyboard's own dictation key: Firetower's whole
 * architecture is that nothing leaves machines you own, and a composer that
 * shipped audio to a transcription service to reach an agent running on your
 * own hardware would be the one place that stopped being true.
 *
 * Interim results land in the composer as they arrive, so it reads as writing
 * rather than as waiting. What is there when you stop is what you get; nothing
 * is sent.
 *
 * **Stopping and cancelling are different things.** Stop keeps the words and
 * gives them back to you to edit. Cancel throws them away and puts back
 * whatever was in the box before you pressed the microphone — which is the
 * only reason it is safe to dictate on top of a draft.
 */
import { useCallback, useEffect, useState } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

export type Dictation = {
  listening: boolean;
  /** What has been heard so far, including the part still being revised. */
  heard: string;
  /**
   * How loud it is right now, 0 to 1, on the UI thread.
   *
   * A shared value rather than state: this changes ten times a second and
   * nothing about it should cost a React render.
   */
  level: SharedValue<number>;
  start: () => Promise<void>;
  /** Keep the words. */
  stop: () => void;
  /** Throw them away. */
  cancel: () => void;
  /** Why it will not run, when it will not. */
  trouble: string | null;
};

/** The reported level runs about -2 (silence) to 10 (shouting). */
const FLOOR = 0;
const CEILING = 8;

export function useDictation(): Dictation {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);
  const level = useSharedValue(0);

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    level.value = 0;
  });
  useSpeechRecognitionEvent("result", (e) => {
    const said = e.results?.[0]?.transcript ?? "";
    if (said) setHeard(said);
  });
  useSpeechRecognitionEvent("volumechange", (e) => {
    const loud = (e.value - FLOOR) / (CEILING - FLOOR);
    level.value = Math.max(0, Math.min(1, loud));
  });
  useSpeechRecognitionEvent("error", (e) => {
    setListening(false);
    // `no-speech` is somebody pressing it and saying nothing, which is not an
    // error worth a banner.
    if (e.error !== "no-speech" && e.error !== "aborted") setTrouble(e.message ?? e.error);
  });

  useEffect(() => () => ExpoSpeechRecognitionModule.abort(), []);

  const start = useCallback(async () => {
    setTrouble(null);
    setHeard("");
    const allowed = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!allowed.granted) {
      setTrouble("Firetower needs the microphone and speech recognition to do this.");
      return;
    }
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
      /* On device, and said so rather than assumed: iOS will fall back to the
         network otherwise, which is the thing this is here to avoid. */
      requiresOnDeviceRecognition: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    });
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  /* `abort` rather than `stop`: stop asks for a final transcript, which would
     arrive after we had already put the old draft back. */
  const cancel = useCallback(() => {
    ExpoSpeechRecognitionModule.abort();
    setHeard("");
  }, []);

  return { listening, heard, level, start, stop, cancel, trouble };
}
