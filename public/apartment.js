import { buildMapTarget, readSelectedApartment } from "./apartment-tools.js";

const content = document.querySelector("#apartment-content");
const unavailable = document.querySelector("#apartment-unavailable");
const name = document.querySelector("#apartment-name");
const address = document.querySelector("#apartment-address");
const note = document.querySelector("#apartment-note");
const maps = document.querySelector("#apartment-maps");
const back = document.querySelector("#apartment-back");

function goBack() {
  if (history.length > 1) history.back();
  else location.href = "/";
}

back.addEventListener("click", goBack);

const apartment = readSelectedApartment(sessionStorage);
if (!apartment?.noteBody) {
  content.hidden = true;
  unavailable.hidden = false;
} else {
  name.textContent = apartment.name;
  note.textContent = apartment.noteBody;

  if (apartment.address) {
    address.textContent = apartment.address;
    address.hidden = false;
  }

  const mapTarget = buildMapTarget(apartment.address, apartment.mapsUrl);
  if (mapTarget) {
    maps.href = mapTarget.href;
    maps.hidden = false;
    maps.setAttribute("aria-label", `Открыть ${apartment.name} в картах`);
    if (mapTarget.external) {
      maps.target = "_blank";
      maps.rel = "noopener noreferrer";
    }
  }
}
