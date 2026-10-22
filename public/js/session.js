// Anmeldung: Antwortet der Server mit „Anmeldung erforderlich“ (Sitzung abgelaufen oder auf
// diesem Gerät noch nicht angemeldet), zur Anmeldeseite wechseln und danach hierher zurück.

const nativeFetch = window.fetch.bind(window);
let leaving = false;

window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401 && res.headers.get('X-Login-Required') && !leaving) {
    leaving = true;
    window.location.href = `login?next=${encodeURIComponent(`/${window.location.hash}`)}`;
  }
  return res;
};
