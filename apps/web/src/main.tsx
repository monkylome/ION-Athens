import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/sofia-sans-condensed";
import "@fontsource-variable/sofia-sans";
import "./styles/app.css";
import { Missions } from "./missions/Missions";
import { Play } from "./play/Play";
import { DeviceSettings } from "./devices/Settings";
import { Phone } from "./phone/Phone";
import { Stage } from "./stage/Stage";
import { Person } from "./assist/Person";
import { Helper } from "./assist/Helper";
import { Trail } from "./trail/Trail";
import { About } from "./about/About";
import { Scan } from "./scan/Scan";

function BackupLabel() {
  const { pathname, search } = useLocation();
  if (!(pathname === "/stage" || pathname === "/play") || new URLSearchParams(search).get("backup") !== "1") return null;
  return <span className="backup-label" lang="el">ΗΧΟΓΡΑΦΗΜΕΝΟ</span>;
}

function Home() {
  return (
    <main className="page" data-surface="phone">
      <h1>ION Athens</h1>
      <p className="page__lead">
        Ο χάρτης της Αθήνας που φτιάχνουν οι ίδιοι οι δημότες, για να περπατά ο καθένας όπως του ταιριάζει σήμερα.
      </p>
      <nav aria-label="Οθόνες">
        <Link className="btn" to="/stage">Οθόνη σκηνής, για το κοινό</Link>
        <Link className="btn" to="/phone">Τηλέφωνο, στο χέρι του πεζού</Link>
        <Link className="btn" to="/play">Παιχνίδι: αποστολές στον χάρτη</Link>
        <Link className="btn" to="/missions">Αποστολές πολιτών</Link>
        <Link className="btn" to="/phone/devices">Σήματα συσκευής</Link>
        <Link className="btn btn--quiet" to="/about">Σχετικά</Link>
      </nav>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <BackupLabel />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/stage" element={<Stage />} />
      <Route path="/play" element={<Play />} />
      <Route path="/missions" element={<Missions />} />
      <Route path="/phone" element={<Phone />} />
      <Route path="/phone/devices" element={<DeviceSettings />} />
      <Route path="/phone/help" element={<Person />} />
      <Route path="/missions/help" element={<Helper />} />
      <Route path="/play/trail" element={<Trail />} />
      <Route path="/play/scan" element={<Scan />} />
      <Route path="/about" element={<About />} />
    </Routes>
  </BrowserRouter>,
);
