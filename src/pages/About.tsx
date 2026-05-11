export function About() {
  return (
    <article className="about">
      <h2>About atlas</h2>
      <p>
        atlas is a personal teacher that watches what you build with AI tooling and
        turns it into phone-readable lessons. It runs as a NauroLabs experiment.
      </p>
      <h3>How it works</h3>
      <p>
        You connect any public GitHub repo you own (or one shared with you), and atlas
        reads its README, file tree, recent commits and project docs. The signal is fed
        to a Microsoft Foundry agent that maintains a knowledge taxonomy, proposes
        lesson backlog items, prioritises them, and writes 300–900 word lessons
        grounded in both your activity and authoritative sources (Microsoft Learn, web).
      </p>
      <p className="muted">
        Sign in with GitHub, hit <strong>+ Add repo</strong> in the profile menu, and
        paste a repo URL. atlas writes a short starter lesson within seconds and keeps
        topping up your unread queue from there.
      </p>
      <h3>What's live today</h3>
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
        <li>
          <strong>Topic atlas</strong> — a graph view of every topic atlas has covered
          for this repo, with edges between topics that suggest each other
        </li>
        <li>
          <strong>Ask-more chat</strong> — follow-up Q&amp;A on any lesson, grounded in
          its body and citations
        </li>
        <li>Theme and language preferences sync across your devices</li>
        <li>
          <strong>Private repos</strong> — paste a fine-grained GitHub token in{' '}
          <strong>Settings</strong> and browse-and-pick your private repos with a
          one-tap checklist
        </li>
      </ul>
      <h3>Coming up</h3>
      <ul>
        <li>Saved highlights and notes per lesson</li>
        <li>
          <strong>Seamless GitHub sign-in</strong> — today private repos require pasting
          a fine-grained token. The next step is a full OAuth sign-in flow (Azure Static
          Web Apps Standard tier, ~$9/month) where atlas asks GitHub for repo permission
          at login and you tick the repos right there — no token in sight. Tracked as a
          paid-tier upgrade; will ship once a second researcher connects 5+ private repos
          to atlas.
        </li>
      </ul>
    </article>
  );
}
