/// <reference types="nativewind/types" />

/* The Tailwind entry is a side-effect import that Metro turns into styles;
   TypeScript has no idea what a `.css` file is and says so. */
declare module "*.css";
