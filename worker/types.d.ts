// Vite's ?raw imports, which the CSV byte-comparison tests use to read the
// captured exports as text. The test runtime resolves them; this is only so
// tsc knows their type.
declare module "*.csv?raw" {
  const content: string;
  export default content;
}
