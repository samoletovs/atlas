import type { useGenerationQuota } from '../lib/useGenerationQuota';

export function GenerationQuotaNotice({ quota, className }: {
  quota: ReturnType<typeof useGenerationQuota>;
  className: string;
}) {
  return (
    <>
      {quota.reached && (
        <p className={className} role="status">
          Your generation limit has been reached. You can still read ready lessons.
        </p>
      )}
      {quota.error && (
        <div role="alert">
          <p className={className}>
            The daily limit couldn't be refreshed. The server still checks every generation request.
            {' '}{quota.error}
          </p>
          <button
            type="button"
            className="btn-secondary"
            disabled={quota.refreshing}
            onClick={() => { void quota.refresh(); }}
          >
            {quota.refreshing ? 'Retrying daily limit...' : 'Retry daily limit'}
          </button>
        </div>
      )}
    </>
  );
}
