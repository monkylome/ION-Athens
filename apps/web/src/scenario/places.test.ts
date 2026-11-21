import { describe, expect, it } from "vitest";
import { fold, matchPlace, placeWords, searchPlaces, type PlaceRecord } from "./places";

const place = (name: string, kind: string, lng = 23.72, lat = 37.97): PlaceRecord => ({ id: name, name, kind, lng, lat, nearestNodeId: "n" });
const places = [
  place("Γενική Γραμματεία Δήμου Αθηναίων", "townhall"),
  place("Δημαρχείο Αθηνών", "townhall"),
  place("Πολυκλινική Αθηνών", "hospital"),
  place("ΚΕΠ Συντάγματος", "kep", 23.735, 37.975),
  place("ΚΕΠ Ακαδημίας", "kep", 23.733, 37.981),
];

describe("the local catalogue of places", () => {
  it("compares Greek words whatever the accents, the case and the ending", () => {
    expect(fold("Δημαρχείο ΑΘΗΝΏΝ, Ερμής")).toBe("δημαρχειο αθηνων, ερμησ");
    expect(placeWords("Θέλω να πάω στο Δημαρχείο")).toEqual(["δημαρχειο"]);
    expect(searchPlaces(places, "πήγαινέ με στου δημαρχείου")?.name).toBe("Δημαρχείο Αθηνών");
  });

  it("puts a place whose name was said before one that is only of that kind", () => {
    expect(matchPlace(places, "Θέλω να πάω στο Δημαρχείο")).toMatchObject({ place: { name: "Δημαρχείο Αθηνών" }, share: 1 });
  });

  it("finds a place by its kind, the nearest first", () => {
    expect(searchPlaces(places, "Θέλω να πάω στο νοσοκομείο")?.name).toBe("Πολυκλινική Αθηνών");
    expect(searchPlaces(places, "το πιο κοντινό ΚΕΠ", { lng: 23.7335, lat: 37.9805 })?.name).toBe("ΚΕΠ Ακαδημίας");
  });

  it("returns nothing for a sentence that names no place it knows", () => {
    expect(searchPlaces(places, "κάπου ωραία")).toBeNull();
    expect(searchPlaces(places, "θέλω να πάω")).toBeNull();
  });
});
