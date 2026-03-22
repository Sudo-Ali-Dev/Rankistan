export default function Footer() {
  return (
    <footer className="bg-surface-container-lowest border-t border-outline-variant w-full mt-12">
      <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-center gap-6 font-mono text-[10px] uppercase tracking-widest text-outline-variant">
        <div className="flex items-center gap-2">
          <span>© 2024 PAKDEV INDEX</span>
          <span className="hidden md:inline">//</span>
          <span className="hidden md:inline">BUILT FOR THE HIGH-PERFORMANCE ENGINEER</span>
        </div>
        <nav className="flex gap-6">
          <a className="hover:text-primary transition-colors" href="#">Documentation</a>
          <a className="hover:text-primary transition-colors" href="#">GitHub</a>
          <a className="hover:text-primary transition-colors" href="#">Discord</a>
        </nav>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-tertiary">
            <span className="w-1.5 h-1.5 bg-tertiary rounded-full animate-pulse"></span>
            <span>ALL_SYSTEMS_OPERATIONAL</span>
          </div>
          <span className="text-outline-variant/30 hidden lg:inline">|</span>
          <span className="hidden lg:inline">V1.0.4-STABLE</span>
        </div>
      </div>
    </footer>
  );
}
