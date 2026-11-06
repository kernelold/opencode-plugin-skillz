import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

const auth = z.object({ authEnv: z.string().min(1), header: z.string().optional(), prefix: z.string().optional(), query: z.string().optional() });
const options = z.object({ skills: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(), auth: auth.optional(), version: z.string().optional(), sha256: z.string().optional() });
const source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('md-url'), url: z.string() }),
  z.object({ type: z.literal('archive-url'), url: z.string(), format: z.enum(['zip', 'tar.gz', 'tgz']), sha256: z.string().optional() }),
  z.object({ type: z.literal('http-folder'), url: z.string() }),
  z.object({ type: z.literal('git'), url: z.string(), ref: z.string().optional(), sha: z.string().optional(), subpath: z.string().optional() }),
  z.object({ type: z.literal('local'), path: z.string() }),
  z.object({ type: z.literal('marketplace-url'), url: z.string() }),
]);
const record = z.object({ id: z.string(), source, options, name: z.string().optional(), parentId: z.string().optional(), catalog: z.boolean().optional(), description: z.string().optional(), license: z.string().optional() });
const skill = z.object({ id: z.string(), dir: z.string(), skillFile: z.string(), name: z.string(), description: z.string(), category: z.string().optional(), version: z.string().optional(), license: z.string().optional(), autoinvoke: z.boolean().optional() });
const installed = z.object({ sourceId: z.string(), version: z.string(), current: z.string(), skills: z.array(skill), enabled: z.boolean(), scope: z.literal('user'), overrides: z.array(z.string()), abandoned: z.boolean().optional(), formerSource: record.optional(), upstream: record.optional(), excludedSkills: z.array(z.string()).optional(), disabledSkills: z.array(z.string()).optional() });
const issue = z.object({ code: z.string(), message: z.string(), path: z.string().optional(), entry: z.string().optional() });
const updateInfo = z.object({ sourceId: z.string(), installedVersion: z.string(), availableVersion: z.string().optional(), updateAvailable: z.boolean(), issues: z.array(issue) });
const id = z.object({ sourceId: z.string().min(1) });
const confirmation = z.object({ confirmOverride: z.boolean().default(false), automatic: z.boolean().default(false), exclude: z.array(z.string()).optional() });
const collisionErrors = { collision: z.object({ id: z.string(), origin: z.string(), canOverride: z.boolean() }) };

// Transport confirmation is explicit and defaults to No. In-process callers can use a callback.
export const methods = {
  listSources: { input: z.void(), output: z.array(record) },
  addSource: { input: z.object({ input: z.union([z.string(), source]), options: options.optional() }), output: record },
  previewRemoveSource: { input: id, output: z.object({ sourceId: z.string(), source: record.optional(), entries: z.array(installed), skillCount: z.number(), revision: z.string() }) },
  removeSource: { input: id.extend({ skills: z.enum(['remove', 'keep']), revision: z.string().optional() }), output: z.void() },
  refresh: { input: z.void(), output: z.array(issue) },
  listAvailable: { input: z.object({ sourceId: z.string().optional() }).optional(), output: z.array(record.extend({ skills: z.array(z.string()).optional(), skillChoices: z.array(z.object({ id: z.string(), name: z.string(), category: z.string().optional(), excluded: z.boolean() })).optional(), version: z.string().optional() })) },
  install: { input: id.extend({ options: confirmation.optional() }), output: installed, errors: collisionErrors },
  update: { input: id.extend({ options: confirmation.optional() }), output: installed, errors: collisionErrors },
  checkUpdates: { input: z.void(), output: z.array(updateInfo) },
  listUpdateStatus: { input: z.void(), output: z.object({ checkedAt: z.string().nullable(), updates: z.array(updateInfo) }) },
  remove: { input: id.extend({ skillId: z.string().min(1).optional() }), output: z.void() },
  setEnabled: { input: id.extend({ enabled: z.boolean(), skillId: z.string().min(1).optional(), options: confirmation.optional() }), output: installed, errors: collisionErrors },
  listInstalled: { input: z.void(), output: z.array(installed) },
  listErrors: { input: z.void(), output: z.array(issue.extend({ id: z.string(), created: z.string(), sourceId: z.string().optional() })) },
  clearErrors: { input: z.void(), output: z.void() },
} as const;
export const SkillzRpc = Rpc.define({ id: 'skillz', methods, events: {} });
export type MethodName = keyof typeof methods;
export type MethodInput<M extends MethodName> = z.input<(typeof methods)[M]['input']>;
export type MethodOutput<M extends MethodName> = z.output<(typeof methods)[M]['output']>;
export type SkillzMethods = {
  [M in MethodName]: undefined extends MethodInput<M>
    ? (input?: MethodInput<M>) => Promise<MethodOutput<M>>
    : (input: MethodInput<M>) => Promise<MethodOutput<M>>;
};
