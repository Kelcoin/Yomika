export type NavigationSpring = { position: number; velocity: number };

/** Unit-mass damped spring. Small integration steps keep 60–120 Hz behavior
 * consistent; a suspended frame cannot inject seconds of accumulated motion. */
export function advanceNavigationSpring(state: NavigationSpring, target: number, seconds: number, dragging: boolean): NavigationSpring {
  const elapsed = Math.min(0.032, Math.max(0, seconds));
  const steps = Math.max(1, Math.ceil(elapsed / 0.004));
  const dt = elapsed / steps;
  const stiffness = dragging ? 1600 : 500;
  const damping = dragging ? 52 : 22;
  let { position, velocity } = state;
  for (let i = 0; i < steps; i++) {
    velocity += (stiffness * (target - position) - damping * velocity) * dt;
    position += velocity * dt;
  }
  return { position, velocity };
}
