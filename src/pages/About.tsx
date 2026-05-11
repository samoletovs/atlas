export function About() {
  return (
    <article className="about">
      <h2>About atlas</h2>
      <p>
        atlas is a personal teacher that watches what you build with AI tooling and
        turns it into phone-readable lessons. It runs as a NauroLabs experiment, single
        user (you).
      </p>
      <h3>How it works</h3>
      <p>
        A daily collector reads your <code>samoletovs/*</code> GitHub repos — commits,
        READMEs, AGENTS.md, reports — and feeds activity events to a Microsoft Foundry
        agent. The agent maintains a knowledge taxonomy that grows from your work,
        proposes lesson backlog items, prioritizes them, and writes 300–900 word
        lessons grounded in both your activity and authoritative sources (Microsoft
        Learn, web).
      </p>
      <h3>Phase 0 status (today)</h3>
      <ul>
        <li>Cosmos DB live in Sweden Central</li>
        <li>Foundry agent <code>atlas-teacher</code> generates lessons</li>
        <li>Multi-repo schema with shareable read-only invites</li>
        <li>
          Autonomous backlog — opt in per repo from <strong>Admin</strong>;
          atlas reads recent commits and tops up your unread queue every
          4 / 8 / 12 / 24 hours
        </li>
        <li>PWA reader with offline caching</li>
      </ul>
      <h3>Coming up</h3>
      <ul>
        <li>Topic atlas graph view</li>
        <li>Ask-more chat</li>
      </ul>
    </article>
  );
}
