export interface ModelRecommendation {
  model: string;
}

// Keep this fallback aligned with Ollama's built-in launch recommendations.
// Server recommendations remain the source of truth when they are available.
export const builtInModelRecommendations: readonly ModelRecommendation[] = [
  { model: 'kimi-k2.6:cloud' },
  { model: 'qwen3.5:cloud' },
  { model: 'glm-5.1:cloud' },
  { model: 'minimax-m2.7:cloud' },
  { model: 'gemma4:12b' },
  { model: 'qwen3.5' }
];

export class OutdatedModelWarningTracker {
  private readonly warnedModelsByChat = new Map<string, Set<string>>();

  constructor(private readonly maxChats = 100) {}

  hasShown(chatKey: string, model: string): boolean {
    return this.warnedModelsByChat.get(chatKey)?.has(warningModelKey(model)) ?? false;
  }

  markShown(chatKey: string, model: string): void {
    let warnedModels = this.warnedModelsByChat.get(chatKey);
    if (!warnedModels) {
      if (this.warnedModelsByChat.size >= this.maxChats) {
        const oldestChat = this.warnedModelsByChat.keys().next().value;
        if (oldestChat !== undefined) {
          this.warnedModelsByChat.delete(oldestChat);
        }
      }
      warnedModels = new Set<string>();
      this.warnedModelsByChat.set(chatKey, warnedModels);
    }
    warnedModels.add(warningModelKey(model));
  }
}

const outdatedAgentModelFamilies = new Set([
  'codellama',
  'llama3',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'mistral',
  'qwen2.5',
  'qwen2.5-coder',
  'starcoder'
]);

const outdatedDeepSeekR1Tags = new Set([
  '',
  'latest',
  '1.5b',
  '7b',
  '8b',
  '14b',
  '32b'
]);

export function parseModelRecommendations(payload: unknown): ModelRecommendation[] {
  if (!isRecord(payload) || !Array.isArray(payload.recommendations)) {
    return [];
  }

  const recommendations: ModelRecommendation[] = [];
  const seen = new Set<string>();
  for (const item of payload.recommendations) {
    if (!isRecord(item) || typeof item.model !== 'string') {
      continue;
    }
    const model = pinnedRecommendationModel(item.model);
    const key = recommendationKey(model);
    if (!model || seen.has(key)) {
      continue;
    }
    seen.add(key);
    recommendations.push({ model });
  }
  return recommendations;
}

export function isRecommendedModel(
  name: string,
  recommendations: readonly ModelRecommendation[]
): boolean {
  const key = recommendationKey(name);
  return recommendations.some(recommendation => recommendationKey(recommendation.model) === key);
}

export function recommendedReplacement<T extends { name: string }>(
  currentModel: string,
  availableModels: readonly T[],
  recommendations: readonly ModelRecommendation[]
): string | undefined {
  const available = new Map(availableModels.map(model => [recommendationKey(model.name), model.name]));
  const currentKey = recommendationKey(currentModel);
  const recommendation = recommendations.find(candidate =>
    recommendationKey(candidate.model) !== currentKey &&
    isCloudModel(candidate.model) === isCloudModel(currentModel)
  );
  if (!recommendation) {
    return undefined;
  }
  return available.get(recommendationKey(recommendation.model)) ?? recommendation.model;
}

export function isOutdatedAgentModel(name: string): boolean {
  const { family, tag } = normalizedModelReference(name);
  if (outdatedAgentModelFamilies.has(family)) {
    return true;
  }
  return family === 'deepseek-r1' && outdatedDeepSeekR1Tags.has(tag);
}

function recommendationKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(':latest') ? normalized.slice(0, -':latest'.length) : normalized;
}

function pinnedRecommendationModel(name: string): string {
  const model = name.trim();
  const normalized = model.toLowerCase();
  if (normalized === 'gemma4' || normalized === 'gemma4:latest') {
    return 'gemma4:12b';
  }
  return model;
}

function warningModelKey(name: string): string {
  return name.trim().toLowerCase();
}

function normalizedModelReference(name: string): { family: string; tag: string } {
  const pathParts = name.trim().toLowerCase().split('/');
  const reference = pathParts.at(-1) ?? '';
  const separator = reference.indexOf(':');
  const family = separator >= 0 ? reference.slice(0, separator) : reference;
  let tag = separator >= 0 ? reference.slice(separator + 1) : '';
  if (tag === 'cloud') {
    tag = '';
  } else if (tag.endsWith('-cloud')) {
    tag = tag.slice(0, -'-cloud'.length);
  }
  return { family, tag };
}

function isCloudModel(name: string): boolean {
  const tag = name.split(':').at(-1)?.toLowerCase() ?? '';
  return tag === 'cloud' || tag.endsWith('-cloud');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
