import React from 'react';

// The app had no error boundary, so any render throw blanked the whole site
// with no way back. A few real candidates: ScoreBreakdownPanel indexing
// activity.byType when a breakdown arrives without `activity`, or Register
// calling .toLowerCase() on a malformed localStorage entry.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-surface">
        <div
          role="alert"
          className="max-w-lg w-full border border-outline-variant bg-surface-container-lowest p-6"
        >
          <h1 className="font-headline text-xl font-bold uppercase tracking-tighter text-on-surface mb-3">
            Something broke
          </h1>
          <p className="font-body text-sm text-on-surface-variant mb-4">
            The page hit an unexpected error. Reloading usually clears it.
          </p>
          <pre className="font-mono text-[11px] text-on-surface-variant bg-surface-container-low border border-outline-variant p-3 mb-4 overflow-x-auto whitespace-pre-wrap">
            {String(error?.message || error)}
          </pre>
          <button
            type="button"
            onClick={this.handleReload}
            className="font-label text-xs uppercase tracking-widest border border-primary text-primary px-4 py-2 hover:bg-primary/10 transition-colors"
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
}
