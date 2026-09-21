/**
 * Picking something to send with a message.
 *
 * The rule is the web build's and it is not an implementation detail:
 * **pictures go inside the message**, because the model looks at them, and
 * **every other file goes into the workspace** with `attach_file` and is only
 * *named* in the message — the agent has its own tools for reading one, and
 * sending the bytes twice is waste.
 *
 * So the camera roll and the camera go one way, and the document picker goes
 * the other.
 */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
/* `expo-file-system`'s top level is `File`/`Directory`/`Paths` as of SDK 57;
   `readAsStringAsync` lives behind the `/legacy` subpath and nowhere else.
   Imported from the root, `FileSystem.readAsStringAsync` was `undefined` —
   so every pick threw `not a function` the moment it tried to read the
   bytes, and attachments have never once worked on a device. */
import * as FileSystem from "expo-file-system/legacy";

/** As much as is worth putting in a turn. The desk's numbers. */
export const BIGGEST_IMAGE = 10 * 1024 * 1024;
export const BIGGEST_FILE = 25 * 1024 * 1024;
export const MOST = 10;

export type Picked =
  /** Goes inside the message: the model looks at it. */
  | { kind: "image"; name: string; uri: string; data: string; mediaType: string; bytes: number }
  /** Goes into the workspace, and is named in the message. */
  | { kind: "file"; name: string; data: string; bytes: number };

export function megabytes(n: number): string {
  return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
}

const b64 = (uri: string) => FileSystem.readAsStringAsync(uri, { encoding: "base64" });

const typeFor = (name: string) => {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" }[
      ext
    ] ?? "image/jpeg"
  );
};

/** The camera roll. Pictures only, because that is what goes inside a message. */
export async function pickImages(): Promise<Picked[]> {
  const allowed = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!allowed.granted) return [];

  const got = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: MOST,
    // The bytes are re-encoded to base64 anyway; asking the picker for them
    // costs a second copy in memory of something already on disk.
    base64: false,
    quality: 0.9,
  });
  if (got.canceled) return [];

  const out: Picked[] = [];
  for (const asset of got.assets) {
    const name = asset.fileName ?? `image.${(asset.uri.split(".").pop() ?? "jpg")}`;
    const bytes = asset.fileSize ?? 0;
    if (bytes > BIGGEST_IMAGE) continue;
    out.push({
      kind: "image",
      name,
      uri: asset.uri,
      data: await b64(asset.uri),
      mediaType: asset.mimeType ?? typeFor(name),
      bytes,
    });
  }
  return out;
}

/** The camera, for when the thing worth showing is in front of you. */
export async function takePhoto(): Promise<Picked[]> {
  const allowed = await ImagePicker.requestCameraPermissionsAsync();
  if (!allowed.granted) return [];

  const got = await ImagePicker.launchCameraAsync({ quality: 0.9 });
  if (got.canceled) return [];

  const asset = got.assets[0];
  const name = asset.fileName ?? "photo.jpg";
  return [
    {
      kind: "image",
      name,
      uri: asset.uri,
      data: await b64(asset.uri),
      mediaType: asset.mimeType ?? typeFor(name),
      bytes: asset.fileSize ?? 0,
    },
  ];
}

/** Anything else. It lands in the workspace, not in the message. */
export async function pickFiles(): Promise<Picked[]> {
  const got = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (got.canceled) return [];

  const out: Picked[] = [];
  for (const asset of got.assets) {
    if ((asset.size ?? 0) > BIGGEST_FILE) continue;
    out.push({
      kind: "file",
      name: asset.name,
      data: await b64(asset.uri),
      bytes: asset.size ?? 0,
    });
  }
  return out;
}
