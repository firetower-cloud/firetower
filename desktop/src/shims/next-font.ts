/**
 * `next/font` compiles fonts at build time and hands back a class name. Here the
 * faces are declared in CSS, so this only has to return the variable names the
 * layout expects.
 */
type Loaded = { variable: string; className: string; style: { fontFamily: string } };

const face = (variable: string, family: string): Loaded => ({
  variable,
  className: "",
  style: { fontFamily: family },
});

export const Archivo = () => face("--font-archivo", "Archivo");
export const Archivo_Narrow = () => face("--font-archivo-narrow", "Archivo Narrow");
export const JetBrains_Mono = () => face("--font-jetbrains", "JetBrains Mono");
