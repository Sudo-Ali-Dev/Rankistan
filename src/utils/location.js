const COUNTRY_ALIASES = ['pakistan', 'pk', 'pak'];
const EXACT_COUNTRY_ALIASES = new Set(COUNTRY_ALIASES);

const PROVINCE_TERMS = [
  'punjab',
  'panjab',
  'sindh',
  'kpk',
  'kp',
  'khyber',
  'pakhtunkhwa',
  'balochistan',
  'baluchistan',
  'baloch',
  'gilgit',
  'baltistan',
  'ajk',
  'jammu',
  'kashmir',
  'ict',
  'federal',
  'capital',
  'territory',
  'islamabad',
];

const LOCATION_NOISE_TERMS = [
  'district',
  'distt',
  'tehsil',
  'taluka',
  'union',
  'council',
  'uc',
  'cantt',
  'cant',
  'cantonment',
  'phase',
  'sector',
  'floor',
  'block',
  'road',
  'rd',
  'street',
  'st',
  'town',
  'city',
  'colony',
  'society',
  'near',
  'school',
  'university',
  'college',
  'campus',
  'the',
  'of',
  'and',
  'soft',
  'international',
  'innovators',
  'smart',
  'valley',
  'asia',
  'h',
];

const CITY_ALIASES = {
  karachi: [
    'karachi',
    'khi',
    'new karachi',
    'karachi central',
    'karachi east',
    'karachi west',
    'karachi south',
    'korangi',
    'malir',
    'keamari',
    'kemari',
    'north nazimabad',
    'gulshan e iqbal',
    'orangi',
  ],
  lahore: ['lahore', 'lhr', 'lahor', 'lahore cantt'],
  islamabad: ['islamabad', 'islambad', 'isb', 'islamabad capital territory', 'ict'],
  rawalpindi: ['rawalpindi', 'rwp', 'pindi', 'taxila'],
  wah_cantonment: ['wah cantonment', 'wah cantt', 'wah cant', 'wah city'],
  multan: ['multan', 'mul', 'shujabad'],
  faisalabad: ['faisalabad', 'fsd', 'lyallpur', 'gojra', 'jaranwala', 'samundri'],
  peshawar: ['peshawar', 'peshwar', 'psh'],
  mardan: ['mardan'],
  quetta: ['quetta', 'qta'],
  gujranwala: ['gujranwala', 'grw', 'kamoke', 'kamoki', 'rahwali'],
  sialkot: ['sialkot', 'skt', 'sambrial', 'daska'],
  hyderabad: ['hyderabad', 'hyd', 'latifabad'],
  sahiwal: ['sahiwal', 'chichawatni'],
  okara: ['okara', 'renala khurd', 'dipalpur'],
  swabi: ['swabi', 'jehangirai'],
  swat: ['swat', 'mingora', 'saidu sharif', 'kabal'],
  bahawalpur: ['bahawalpur', 'bahawelpur', 'hasilpur', 'ahmedpur east'],
  sukkur: ['sukkur'],
  larkana: ['larkana'],
  gilgit: ['gilgit'],
  skardu: ['skardu'],
  abbottabad: ['abbottabad', 'abottabad', 'atd'],
  attock: ['attock'],
  gujrat: ['gujrat', 'kharian', 'lala musa', 'jalalpur jattan'],
  vehari: ['vehari', 'mailsi'],
  dera_ghazi_khan: ['dera ghazi khan', 'd g khan', 'dg khan', 'dera ghazi'],
  dera_ismail_khan: ['dera ismail khan', 'd i khan', 'di khan'],
  taunsa_sharif: ['taunsa sharif', 'taunsa'],
  khairpur: ['khairpur'],
  arifwala: ['arifwala', 'arif wala'],
  pirmahal: ['pirmahal'],
  raja_jang: ['raja jang'],
  hala: ['hala'],
  chiniot: ['chiniot'],
  jhang: ['jhang'],
  kasur: ['kasur', 'qasur', 'pattoki'],
  jhelum: ['jhelum'],
  hafizabad: ['hafizabad'],
  khanewal: ['khanewal', 'mian channu', 'mian channun'],
  pakpattan: ['pakpattan', 'pak pattan'],
  chakwal: ['chakwal'],
  mianwali: ['mianwali'],
  bhakkar: ['bhakkar', 'bhakhar'],
  muzaffargarh: ['muzaffargarh', 'muzafargarh'],
  mandi_bahauddin: ['mandi bahauddin', 'mandi baha ud din', 'mandi baha-ud-din', 'mbd'],
  narowal: ['narowal', 'shakargarh'],
  rahim_yar_khan: ['rahim yar khan', 'ryk', 'khanpur'],
  toba_tek_singh: ['toba tek singh', 'toba teksingh', 'tts'],
  nowshera: ['nowshera', 'naushera'],
  charsadda: ['charsadda', 'shabqadar'],
  mansehra: ['mansehra'],
  bannu: ['bannu'],
  chitral: ['chitral', 'upper chitral', 'lower chitral'],
  gwadar: ['gwadar', 'gawadar'],
  turbat: ['turbat', 'kech'],
  khuzdar: ['khuzdar'],
  chaman: ['chaman'],
  hub: ['hub chowki', 'hub'],
  dadu: ['dadu'],
  jacobabad: ['jacobabad'],
  mirpur_khas: ['mirpur khas', 'mirpurkhas'],
  ghotki: ['ghotki'],
  badin: ['badin'],
  tando_allahyar: ['tando allahyar', 'tando allah yar'],
  tando_muhammad_khan: ['tando muhammad khan', 'tando mohammad khan', 'tmk'],
  umerkot: ['umerkot', 'umarkot'],
  muzaffarabad: [
    'muzaffarabad',
    'azad jammu and kashmir',
    'azam jammu and kashmir',
    'university of azad jammu and kashmir',
    'university of azam jammu and kashmir',
    'uajk',
  ],
  mirpur: ['mirpur ajk', 'mirpur azad kashmir', 'mirpur'],
  kotli: ['kotli'],
  rawalakot: ['rawalakot'],
  bhimber: ['bhimber'],
  kotri: ['kotri'],
  sadiqabad: ['sadiqabad'],
  kamra: ['kamra'],
  nawabshah: ['nawabshah', 'benazirabad', 'shaheed benazirabad'],
  haripur: ['haripur'],
  jamshoro: ['jamshoro'],
  sheikhupura: ['sheikhupura', 'muridke', 'ferozewala', 'kot abdul malik'],
  wazirabad: ['wazirabad'],
  kohat: ['kohat'],
  sargodha: ['sargodha'],
  khushab: ['khushab', 'jauharabad'],
  lodhran: ['lodhran'],
  layyah: ['layyah'],
  kot_addu: ['kot addu'],
  rajanpur: ['rajanpur', 'jampur'],
  shikarpur: ['shikarpur', 'shahdadkot'],
  ormara: ['ormara'],
};

const CITY_LABELS = {
  karachi: 'Karachi',
  lahore: 'Lahore',
  islamabad: 'Islamabad',
  rawalpindi: 'Rawalpindi',
  wah_cantonment: 'Wah Cantonment',
  multan: 'Multan',
  faisalabad: 'Faisalabad',
  peshawar: 'Peshawar',
  mardan: 'Mardan',
  quetta: 'Quetta',
  gujranwala: 'Gujranwala',
  sialkot: 'Sialkot',
  hyderabad: 'Hyderabad',
  sahiwal: 'Sahiwal',
  okara: 'Okara',
  swabi: 'Swabi',
  swat: 'Swat',
  bahawalpur: 'Bahawalpur',
  sukkur: 'Sukkur',
  larkana: 'Larkana',
  gilgit: 'Gilgit',
  skardu: 'Skardu',
  abbottabad: 'Abbottabad',
  attock: 'Attock',
  gujrat: 'Gujrat',
  vehari: 'Vehari',
  dera_ghazi_khan: 'Dera Ghazi Khan',
  dera_ismail_khan: 'Dera Ismail Khan',
  taunsa_sharif: 'Taunsa Sharif',
  khairpur: 'Khairpur',
  arifwala: 'Arifwala',
  pirmahal: 'Pirmahal',
  raja_jang: 'Raja Jang',
  hala: 'Hala',
  chiniot: 'Chiniot',
  jhang: 'Jhang',
  kasur: 'Kasur',
  jhelum: 'Jhelum',
  hafizabad: 'Hafizabad',
  khanewal: 'Khanewal',
  pakpattan: 'Pakpattan',
  chakwal: 'Chakwal',
  mianwali: 'Mianwali',
  bhakkar: 'Bhakkar',
  muzaffargarh: 'Muzaffargarh',
  mandi_bahauddin: 'Mandi Bahauddin',
  narowal: 'Narowal',
  rahim_yar_khan: 'Rahim Yar Khan',
  toba_tek_singh: 'Toba Tek Singh',
  nowshera: 'Nowshera',
  charsadda: 'Charsadda',
  mansehra: 'Mansehra',
  bannu: 'Bannu',
  chitral: 'Chitral',
  gwadar: 'Gwadar',
  turbat: 'Turbat',
  khuzdar: 'Khuzdar',
  chaman: 'Chaman',
  hub: 'Hub',
  dadu: 'Dadu',
  jacobabad: 'Jacobabad',
  mirpur_khas: 'Mirpur Khas',
  ghotki: 'Ghotki',
  badin: 'Badin',
  tando_allahyar: 'Tando Allahyar',
  tando_muhammad_khan: 'Tando Muhammad Khan',
  umerkot: 'Umerkot',
  muzaffarabad: 'Muzaffarabad',
  mirpur: 'Mirpur',
  kotli: 'Kotli',
  rawalakot: 'Rawalakot',
  bhimber: 'Bhimber',
  kotri: 'Kotri',
  sadiqabad: 'Sadiqabad',
  kamra: 'Kamra',
  nawabshah: 'Nawabshah',
  haripur: 'Haripur',
  jamshoro: 'Jamshoro',
  sheikhupura: 'Sheikhupura',
  wazirabad: 'Wazirabad',
  kohat: 'Kohat',
  sargodha: 'Sargodha',
  khushab: 'Khushab',
  lodhran: 'Lodhran',
  layyah: 'Layyah',
  kot_addu: 'Kot Addu',
  rajanpur: 'Rajanpur',
  shikarpur: 'Shikarpur',
  ormara: 'Ormara',
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(location) {
  return String(location || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[._/\\-]/g, ' ')
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toWords(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

function hasCountry(text) {
  const words = toWords(text);
  if (words.some((word) => EXACT_COUNTRY_ALIASES.has(word))) {
    return true;
  }

  return words.some((word) => word.startsWith('pakistan'));
}

function titleCase(words) {
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cityLabel(cityKey) {
  if (CITY_LABELS[cityKey]) {
    return CITY_LABELS[cityKey];
  }

  return titleCase(String(cityKey || '').split('_').filter(Boolean));
}

function cleanWords(text) {
  return toWords(text)
    .map((word) => word.replace(/[^a-z]/g, ''))
    .filter(Boolean)
    .filter((word) => !EXACT_COUNTRY_ALIASES.has(word))
    .filter((word) => !PROVINCE_TERMS.includes(word))
    .filter((word) => !LOCATION_NOISE_TERMS.includes(word));
}

const FLAT_CITY_ALIASES = Object.entries(CITY_ALIASES)
  .flatMap(([cityKey, aliases]) =>
    aliases.map((alias) => {
      const normalizedAlias = normalizeText(alias);
      const compactAlias = normalizedAlias.replace(/\s+/g, '');
      return {
        cityKey,
        alias: normalizedAlias,
        hasSpace: normalizedAlias.includes(' '),
        compactAlias,
        matcher: new RegExp(`(?:^|\\s)${escapeRegex(normalizedAlias)}(?:\\s|$)`),
      };
    })
  )
  .filter((entry) => Boolean(entry.alias))
  .sort((a, b) => b.alias.length - a.alias.length);

function inferCityCandidate(location) {
  const normalized = normalizeText(location);
  if (!normalized) return '';

  const parts = String(location || '')
    .split(/[,/|]/g)
    .map((part) => normalizeText(part))
    .filter(Boolean);

  const sourceParts = parts.length > 0 ? parts : [normalized];
  for (const part of sourceParts) {
    if (hasCountry(part)) {
      continue;
    }

    const words = cleanWords(part);
    if (words.length > 0) {
      return titleCase(words.slice(0, 3));
    }
  }

  if (hasCountry(normalized)) {
    const residualWords = cleanWords(normalized);
    if (residualWords.length > 0) {
      return titleCase(residualWords.slice(0, 3));
    }
  }

  return '';
}

function findCityKey(location) {
  const normalized = normalizeText(location);
  if (!normalized) return '';

  const compact = normalized.replace(/\s+/g, '');

  for (const entry of FLAT_CITY_ALIASES) {
    if (entry.matcher.test(normalized)) {
      return entry.cityKey;
    }

    if (entry.hasSpace && compact.includes(entry.compactAlias)) {
      return entry.cityKey;
    }
  }

  return '';
}

function normalizeLocationForDisplay(location) {
  const normalized = normalizeText(location);
  const cityKey = findCityKey(location);
  if (cityKey) {
    return cityLabel(cityKey);
  }

  if (hasCountry(normalized)) {
    return 'Pakistan';
  }

  const inferredCity = inferCityCandidate(location);
  if (inferredCity) {
    return inferredCity;
  }

  return 'Pakistan';
}

function isLikelyPakistaniLocation(location) {
  const normalized = normalizeText(location);
  if (!normalized) {
    return false;
  }

  if (hasCountry(normalized)) {
    return true;
  }

  return Boolean(findCityKey(normalized));
}

export {
  findCityKey,
  normalizeLocationForDisplay,
  isLikelyPakistaniLocation,
};
