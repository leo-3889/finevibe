import { createTabRegistry, type TabInstance } from '../tab-instance-registry';

export type TeamInstance = TabInstance;

const registry = createTabRegistry<TeamInstance>();

export const instances = registry.instances;

export function getTeamInstance(sessionId: string): TeamInstance | undefined {
  return registry.getInstance(sessionId);
}
