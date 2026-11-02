import { createTabRegistry, type TabInstance } from '../tab-instance-registry';

export type ProjectTabInstance = TabInstance;

const registry = createTabRegistry<ProjectTabInstance>();

export const instances = registry.instances;

export function getProjectTabInstance(sessionId: string): ProjectTabInstance | undefined {
  return registry.getInstance(sessionId);
}
