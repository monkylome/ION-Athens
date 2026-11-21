import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { Button } from "react-aria-components";
import { AthensMap } from "./map/AthensMap";
import { speak } from "./voice/speech";
import "./styles/tokens.css";

function Phone() {
  const [caption, setCaption] = useState("");
  const message = "Ο ήχος ενεργοποιήθηκε.";
  return <main><h1>Τηλέφωνο</h1>
    <Button onPress={() => speak(message, { onStart: () => setCaption(message) })}>Ενεργοποίηση ήχου</Button>
    <p role="status">{caption}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(
  <BrowserRouter><Routes>
    <Route path="/" element={<main><h1>ION Athens</h1><nav><Link to="/stage">Χάρτης</Link><Link to="/phone">Τηλέφωνο</Link></nav></main>} />
    <Route path="/stage" element={<AthensMap />} />
    <Route path="/phone" element={<Phone />} />
  </Routes></BrowserRouter>
);
