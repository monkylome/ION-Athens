import { useEffect, useState } from "react";
import { PROFILES, type ProfileId } from "@ion/core";
import { request } from "../api/client";
import "./profiles.css";

export function Choices({ value, onChoose }: { value: ProfileId; onChoose: (id: ProfileId) => void }) {
  const [profiles, setProfiles] = useState<{ id: ProfileId; label: string }[]>(Object.values(PROFILES));
  useEffect(() => {
    let active = true;
    void request<{ profiles: typeof profiles }>("/profiles").then(data => {
      if (active) setProfiles(data.profiles);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <section className="walk-choice" aria-labelledby="walk-question">
    <h1 id="walk-question" tabIndex={-1}>Πώς θέλετε να περπατήσετε σήμερα;</h1>
    <div>{profiles.map(p => <button type="button" key={p.id} aria-pressed={p.id === value} className="btn"
      onClick={() => {
        try { localStorage.setItem("ion-walk-profile", p.id); } catch { /* Still works for this walk. */ }
        onChoose(p.id);
      }}>{p.label}</button>)}</div>
  </section>;
}
