export type NavigationSpring = { position: number; velocity: number };

/** Unit-mass damped spring. Small integration steps keep 60–120 Hz behavior
 * consistent; a suspended frame cannot inject seconds of accumulated motion. */
export function advanceNavigationSpring(state: NavigationSpring, target: number, seconds: number, dragging: boolean, elastic = false): NavigationSpring {
  const elapsed = Math.min(0.032, Math.max(0, seconds));
  const steps = Math.max(1, Math.ceil(elapsed / 0.004));
  const dt = elapsed / steps;
  // iOS-optimized spring parameters: higher stiffness for immediate response,
  // balanced damping for smooth settle without overshoot
  const stiffness = dragging ? 1800 : elastic ? 580 : 520;
  const damping = dragging ? (elastic ? 46 : 54) : (elastic ? 19 : 23);
  let { position, velocity } = state;
  for (let i = 0; i < steps; i++) {
    velocity += (stiffness * (target - position) - damping * velocity) * dt;
    position += velocity * dt;
  }
  return { position, velocity };
}
