/**
 * The service surface shared by the HTTP routes and the `/economizer` command.
 *
 * Both surfaces render the same computed state; neither owns storage or
 * algorithms. `EconomizerService` implements this interface.
 */
import type { ResolvedConfig } from '../config/schema.js'
import type {
  WireLoops,
  WireMode,
  WireOverview,
  WirePruneMode,
  WireProjects,
  WireSettings,
  WireSkills,
  WireStatus,
  WireTools,
} from '../http/contract.js'

export interface ProjectScopeInput {
  sessionId?: string
  cwd?: string
}

export interface SkillsActionPayload {
  action: 'confirm' | 'reject' | 'delete' | 'clearCandidates'
  ids?: string[]
}

export interface ToolsActionPayload {
  action: 'restore' | 'restoreAll' | 'setMode'
  names?: string[]
  mode?: WirePruneMode
}

export interface LoopsActionPayload {
  action: 'clear'
}

export interface ActionOutcome<T> {
  changed: number
  data: T
}

/** Read/act surface implemented by the runtime service. */
export interface EconomizerApi {
  /** Current resolved configuration (live volatile refs already unwrapped). */
  config(): ResolvedConfig
  status(input: ProjectScopeInput): Promise<WireStatus>
  overview(input: ProjectScopeInput): Promise<WireOverview>
  skills(input: ProjectScopeInput): Promise<WireSkills>
  tools(input: ProjectScopeInput): Promise<WireTools>
  loops(input: ProjectScopeInput): Promise<WireLoops>
  settings(): Promise<WireSettings>
  projects(): Promise<WireProjects>
  skillsAction(payload: SkillsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireSkills>>
  toolsAction(payload: ToolsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireTools>>
  loopsAction(payload: LoopsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireLoops>>
  updateSettings(patch: Record<string, unknown>): Promise<WireSettings>
  setMode(mode: WireMode): Promise<WireMode>
}
