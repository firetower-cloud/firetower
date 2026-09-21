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
 */
import { useCallback, useEffect, useState } from "react";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

export type Dictation = {
  listening: boolean;
  /** What has been heard so far, including the part still being revised. */
  heard: string;
  start: () => Promise<void>;
  stop: () => void;
  /** Why it will not run, when it will not. */
  trouble: string | null;
};

export function useDictation(): Dictation {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("result", (e) => {
    const said = e.results?.[0]?.transcript ?? "";
    if (said) setHeard(said);
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
    });
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  return { listening, heard, start, stop, trouble };
}
