// Collection queries stay outside the parameterized /lessons/{id} namespace.
export const RECOMMENDATIONS_PATH = '/api/recommendations';

export const LESSON_API_CACHE_PATTERN =
  /\/api\/(?:lessons(?:\/[^?]*)?|recommendations)(?:\?.*)?$/;
