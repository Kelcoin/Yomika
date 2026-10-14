/** The static HTML protects the first paint until React mounts. Never replay a
 * timed brand overlay after the native system launch screen. Desktop window
 * visibility remains controlled by index.html frontend_ready and Rust fallback. */
export function SplashFrame() {
  return null;
}
