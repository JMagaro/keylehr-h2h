/**
 * NFL team branding metadata — KeyLehr H2H Fantasy Football League.
 *
 * Logo URLs and brand colors for the 32 NFL teams, embedded in the repo so the
 * backfill does not depend on a file in ~/Downloads. Copied faithfully from the
 * source `nfl_teams.json`.
 *
 * Used by `scripts/update-team-meta.ts` (`npm run team:meta`) to populate the new
 * branding columns on `nfl_teams`.
 *
 * MATCH NOTE: the backfill joins to `nfl_teams` by NICKNAME (`name === nickname`),
 * not abbreviation — `abbr` here is the NFL.com abbreviation ("WAS"), whereas the
 * `nfl_teams.key` column uses the ESPN abbreviation ("WSH"). Nicknames are unique
 * across all 32 teams, so the nickname join sidesteps that mismatch.
 *
 * Empty-string colors (tertiary/quaternary on a few teams) are stored as NULL by
 * the backfill.
 */

export interface TeamMetaColors {
  primary: string;
  secondary: string;
  tertiary: string;
  quaternary: string;
}

export interface TeamMetaIds {
  espn_abbr: string;
  draftkings_label: string;
  nfl_team_id: string;
}

export interface TeamMetaLogos {
  espn: string;
  wordmark: string;
  squared: string;
  wikipedia: string;
}

export interface TeamMeta {
  abbr: string;
  name: string;
  nickname: string;
  conference: 'AFC' | 'NFC';
  division: string;
  colors: TeamMetaColors;
  ids: TeamMetaIds;
  logos: TeamMetaLogos;
}

export const TEAM_META: readonly TeamMeta[] = [
  {
    abbr: 'BUF',
    name: 'Buffalo Bills',
    nickname: 'Bills',
    conference: 'AFC',
    division: 'AFC East',
    colors: { primary: '#00338D', secondary: '#C60C30', tertiary: '#0c2e82', quaternary: '#d50a0a' },
    ids: { espn_abbr: 'BUF', draftkings_label: 'BUF Bills', nfl_team_id: '0610' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/buf.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/BUF.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/BUF.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/7/77/Buffalo_Bills_logo.svg/189px-Buffalo_Bills_logo.svg.png',
    },
  },
  {
    abbr: 'MIA',
    name: 'Miami Dolphins',
    nickname: 'Dolphins',
    conference: 'AFC',
    division: 'AFC East',
    colors: { primary: '#008E97', secondary: '#F58220', tertiary: '#005778', quaternary: '#008e97' },
    ids: { espn_abbr: 'MIA', draftkings_label: 'MIA Dolphins', nfl_team_id: '2700' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/mia.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/MIA.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/MIA.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/3/37/Miami_Dolphins_logo.svg/100px-Miami_Dolphins_logo.svg.png',
    },
  },
  {
    abbr: 'NE',
    name: 'New England Patriots',
    nickname: 'Patriots',
    conference: 'AFC',
    division: 'AFC East',
    colors: { primary: '#002244', secondary: '#C60C30', tertiary: '#b0b7bc', quaternary: '#001532' },
    ids: { espn_abbr: 'NE', draftkings_label: 'NE Patriots', nfl_team_id: '3200' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/NE.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/NE.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/b/b9/New_England_Patriots_logo.svg/100px-New_England_Patriots_logo.svg.png',
    },
  },
  {
    abbr: 'NYJ',
    name: 'New York Jets',
    nickname: 'Jets',
    conference: 'AFC',
    division: 'AFC East',
    colors: { primary: '#003F2D', secondary: '#000000', tertiary: '', quaternary: '' },
    ids: { espn_abbr: 'NYJ', draftkings_label: 'NY Jets', nfl_team_id: '3430' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/NYJ.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/NYJ.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/6/6b/New_York_Jets_logo.svg/100px-New_York_Jets_logo.svg.png',
    },
  },
  {
    abbr: 'BAL',
    name: 'Baltimore Ravens',
    nickname: 'Ravens',
    conference: 'AFC',
    division: 'AFC North',
    colors: { primary: '#241773', secondary: '#9E7C0C', tertiary: '#9e7c0c', quaternary: '#c60c30' },
    ids: { espn_abbr: 'BAL', draftkings_label: 'BAL Ravens', nfl_team_id: '0325' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/bal.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/BAL.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/BAL.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/1/16/Baltimore_Ravens_logo.svg/193px-Baltimore_Ravens_logo.svg.png',
    },
  },
  {
    abbr: 'CIN',
    name: 'Cincinnati Bengals',
    nickname: 'Bengals',
    conference: 'AFC',
    division: 'AFC North',
    colors: { primary: '#FB4F14', secondary: '#000000', tertiary: '#000000', quaternary: '#d32f1e' },
    ids: { espn_abbr: 'CIN', draftkings_label: 'CIN Bengals', nfl_team_id: '0920' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/cin.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/CIN.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/CIN.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Cincinnati_Bengals_logo.svg/100px-Cincinnati_Bengals_logo.svg.png',
    },
  },
  {
    abbr: 'CLE',
    name: 'Cleveland Browns',
    nickname: 'Browns',
    conference: 'AFC',
    division: 'AFC North',
    colors: { primary: '#FF3C00', secondary: '#311D00', tertiary: '#a5acaf', quaternary: '#d32f1e' },
    ids: { espn_abbr: 'CLE', draftkings_label: 'CLE Browns', nfl_team_id: '1050' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/cle.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/CLE.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/CLE.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/d/d9/Cleveland_Browns_logo.svg/100px-Cleveland_Browns_logo.svg.png',
    },
  },
  {
    abbr: 'PIT',
    name: 'Pittsburgh Steelers',
    nickname: 'Steelers',
    conference: 'AFC',
    division: 'AFC North',
    colors: { primary: '#000000', secondary: '#FFB612', tertiary: '#c60c30', quaternary: '#00539b' },
    ids: { espn_abbr: 'PIT', draftkings_label: 'PIT Steelers', nfl_team_id: '3900' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/pit.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/PIT.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/PIT.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Pittsburgh_Steelers_logo.svg/100px-Pittsburgh_Steelers_logo.svg.png',
    },
  },
  {
    abbr: 'HOU',
    name: 'Houston Texans',
    nickname: 'Texans',
    conference: 'AFC',
    division: 'AFC South',
    colors: { primary: '#03202F', secondary: '#A71930', tertiary: '#00071c', quaternary: '#a30d2d' },
    ids: { espn_abbr: 'HOU', draftkings_label: 'HOU Texans', nfl_team_id: '2120' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/hou.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/HOU.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/HOU.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/2/28/Houston_Texans_logo.svg/100px-Houston_Texans_logo.svg.png',
    },
  },
  {
    abbr: 'IND',
    name: 'Indianapolis Colts',
    nickname: 'Colts',
    conference: 'AFC',
    division: 'AFC South',
    colors: { primary: '#002C5F', secondary: '#a5acaf', tertiary: '#013369', quaternary: '#9ba1a2' },
    ids: { espn_abbr: 'IND', draftkings_label: 'IND Colts', nfl_team_id: '2200' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/ind.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/IND.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/IND.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Indianapolis_Colts_logo.svg/100px-Indianapolis_Colts_logo.svg.png',
    },
  },
  {
    abbr: 'JAX',
    name: 'Jacksonville Jaguars',
    nickname: 'Jaguars',
    conference: 'AFC',
    division: 'AFC South',
    colors: { primary: '#006778', secondary: '#000000', tertiary: '#9f792c', quaternary: '#d7a22a' },
    ids: { espn_abbr: 'JAX', draftkings_label: 'JAX Jaguars', nfl_team_id: '2250' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/jax.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/JAX.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/JAX.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/7/74/Jacksonville_Jaguars_logo.svg/100px-Jacksonville_Jaguars_logo.svg.png',
    },
  },
  {
    abbr: 'TEN',
    name: 'Tennessee Titans',
    nickname: 'Titans',
    conference: 'AFC',
    division: 'AFC South',
    colors: { primary: '#4495D2', secondary: '#D50A0A', tertiary: '', quaternary: '' },
    ids: { espn_abbr: 'TEN', draftkings_label: 'TEN Titans', nfl_team_id: '2100' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/ten.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/TEN.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/TEN.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/53/Tennessee_Titans_Logo_2026.svg/250px-Tennessee_Titans_Logo_2026.svg.png',
    },
  },
  {
    abbr: 'DEN',
    name: 'Denver Broncos',
    nickname: 'Broncos',
    conference: 'AFC',
    division: 'AFC West',
    colors: { primary: '#002244', secondary: '#FB4F14', tertiary: '#00234c', quaternary: '#ff5200' },
    ids: { espn_abbr: 'DEN', draftkings_label: 'DEN Broncos', nfl_team_id: '1400' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/DEN.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/DEN.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/4/44/Denver_Broncos_logo.svg/100px-Denver_Broncos_logo.svg.png',
    },
  },
  {
    abbr: 'KC',
    name: 'Kansas City Chiefs',
    nickname: 'Chiefs',
    conference: 'AFC',
    division: 'AFC West',
    colors: { primary: '#E31837', secondary: '#FFB612', tertiary: '#000000', quaternary: '#e31837' },
    ids: { espn_abbr: 'KC', draftkings_label: 'KC Chiefs', nfl_team_id: '2310' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/KC.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/KC.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e1/Kansas_City_Chiefs_logo.svg/100px-Kansas_City_Chiefs_logo.svg.png',
    },
  },
  {
    abbr: 'LV',
    name: 'Las Vegas Raiders',
    nickname: 'Raiders',
    conference: 'AFC',
    division: 'AFC West',
    colors: { primary: '#000000', secondary: '#A5ACAF', tertiary: '#a6aeb0', quaternary: '#000000' },
    ids: { espn_abbr: 'LV', draftkings_label: 'LV Raiders', nfl_team_id: '2520' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/lv.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/LV.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/LV.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/4/48/Las_Vegas_Raiders_logo.svg/100px-Las_Vegas_Raiders_logo.svg.png',
    },
  },
  {
    abbr: 'LAC',
    name: 'Los Angeles Chargers',
    nickname: 'Chargers',
    conference: 'AFC',
    division: 'AFC West',
    colors: { primary: '#007BC7', secondary: '#ffc20e', tertiary: '#ffb612', quaternary: '#001532' },
    ids: { espn_abbr: 'LAC', draftkings_label: 'LA Chargers', nfl_team_id: '4400' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/lac.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/LAC.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/LAC.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/7/72/NFL_Chargers_logo.svg/100px-NFL_Chargers_logo.svg.png',
    },
  },
  {
    abbr: 'DAL',
    name: 'Dallas Cowboys',
    nickname: 'Cowboys',
    conference: 'NFC',
    division: 'NFC East',
    colors: { primary: '#002244', secondary: '#B0B7BC', tertiary: '#acc0c6', quaternary: '#a5acaf' },
    ids: { espn_abbr: 'DAL', draftkings_label: 'DAL Cowboys', nfl_team_id: '1200' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/DAL.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/DAL.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/Dallas_Cowboys.svg/100px-Dallas_Cowboys.svg.png',
    },
  },
  {
    abbr: 'NYG',
    name: 'New York Giants',
    nickname: 'Giants',
    conference: 'NFC',
    division: 'NFC East',
    colors: { primary: '#0B2265', secondary: '#A71930', tertiary: '#a5acaf', quaternary: '#012352' },
    ids: { espn_abbr: 'NYG', draftkings_label: 'NY Giants', nfl_team_id: '3410' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/NYG.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/NYG.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/New_York_Giants_logo.svg/100px-New_York_Giants_logo.svg.png',
    },
  },
  {
    abbr: 'PHI',
    name: 'Philadelphia Eagles',
    nickname: 'Eagles',
    conference: 'NFC',
    division: 'NFC East',
    colors: { primary: '#004C54', secondary: '#A5ACAF', tertiary: '#acc0c6', quaternary: '#000000' },
    ids: { espn_abbr: 'PHI', draftkings_label: 'PHI Eagles', nfl_team_id: '3700' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/PHI.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/PHI.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8e/Philadelphia_Eagles_logo.svg/100px-Philadelphia_Eagles_logo.svg.png',
    },
  },
  {
    abbr: 'WAS',
    name: 'Washington Commanders',
    nickname: 'Commanders',
    conference: 'NFC',
    division: 'NFC East',
    colors: { primary: '#5A1414', secondary: '#FFB612', tertiary: '#000000', quaternary: '#5b2b2f' },
    ids: { espn_abbr: 'WSH', draftkings_label: 'WAS Commanders', nfl_team_id: '5110' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/WAS.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/WAS.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e2/Washington_commanders.svg/100px-Washington_commanders.svg.png',
    },
  },
  {
    abbr: 'CHI',
    name: 'Chicago Bears',
    nickname: 'Bears',
    conference: 'NFC',
    division: 'NFC North',
    colors: { primary: '#0B162A', secondary: '#E64100', tertiary: '#0b162a', quaternary: '#E64100' },
    ids: { espn_abbr: 'CHI', draftkings_label: 'CHI Bears', nfl_team_id: '0810' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/chi.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/CHI.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/CHI.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Chicago_Bears_logo.svg/100px-Chicago_Bears_logo.svg.png',
    },
  },
  {
    abbr: 'DET',
    name: 'Detroit Lions',
    nickname: 'Lions',
    conference: 'NFC',
    division: 'NFC North',
    colors: { primary: '#0076B6', secondary: '#B0B7BC', tertiary: '#000000', quaternary: '#004e89' },
    ids: { espn_abbr: 'DET', draftkings_label: 'DET Lions', nfl_team_id: '1540' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/det.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/DET.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/DET.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/7/71/Detroit_Lions_logo.svg/100px-Detroit_Lions_logo.svg.png',
    },
  },
  {
    abbr: 'GB',
    name: 'Green Bay Packers',
    nickname: 'Packers',
    conference: 'NFC',
    division: 'NFC North',
    colors: { primary: '#203731', secondary: '#FFB612', tertiary: '#1c2d25', quaternary: '#eead1e' },
    ids: { espn_abbr: 'GB', draftkings_label: 'GB Packers', nfl_team_id: '1800' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/gb.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/GB.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/GB.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/Green_Bay_Packers_logo.svg/100px-Green_Bay_Packers_logo.svg.png',
    },
  },
  {
    abbr: 'MIN',
    name: 'Minnesota Vikings',
    nickname: 'Vikings',
    conference: 'NFC',
    division: 'NFC North',
    colors: { primary: '#4F2683', secondary: '#FFC62F', tertiary: '#e9bf9b', quaternary: '#000000' },
    ids: { espn_abbr: 'MIN', draftkings_label: 'MIN Vikings', nfl_team_id: '3000' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/min.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/MIN.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/MIN.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/4/48/Minnesota_Vikings_logo.svg/98px-Minnesota_Vikings_logo.svg.png',
    },
  },
  {
    abbr: 'ATL',
    name: 'Atlanta Falcons',
    nickname: 'Falcons',
    conference: 'NFC',
    division: 'NFC South',
    colors: { primary: '#A71930', secondary: '#000000', tertiary: '#a5acaf', quaternary: '#a30d2d' },
    ids: { espn_abbr: 'ATL', draftkings_label: 'ATL Falcons', nfl_team_id: '0200' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/atl.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/ATL.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/ATL.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/c/c5/Atlanta_Falcons_logo.svg/192px-Atlanta_Falcons_logo.svg.png',
    },
  },
  {
    abbr: 'CAR',
    name: 'Carolina Panthers',
    nickname: 'Panthers',
    conference: 'NFC',
    division: 'NFC South',
    colors: { primary: '#0085CA', secondary: '#000000', tertiary: '#bfc0bf', quaternary: '#0085ca' },
    ids: { espn_abbr: 'CAR', draftkings_label: 'CAR Panthers', nfl_team_id: '0750' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/car.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/CAR.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/CAR.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/1/1c/Carolina_Panthers_logo.svg/100px-Carolina_Panthers_logo.svg.png',
    },
  },
  {
    abbr: 'NO',
    name: 'New Orleans Saints',
    nickname: 'Saints',
    conference: 'NFC',
    division: 'NFC South',
    colors: { primary: '#D3BC8D', secondary: '#000000', tertiary: '#9f8958', quaternary: '#000000' },
    ids: { espn_abbr: 'NO', draftkings_label: 'NO Saints', nfl_team_id: '3300' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/no.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/NO.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/NO.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/New_Orleans_Saints_logo.svg/98px-New_Orleans_Saints_logo.svg.png',
    },
  },
  {
    abbr: 'TB',
    name: 'Tampa Bay Buccaneers',
    nickname: 'Buccaneers',
    conference: 'NFC',
    division: 'NFC South',
    colors: { primary: '#A71930', secondary: '#322F2B', tertiary: '#000000', quaternary: '#ff7900' },
    ids: { espn_abbr: 'TB', draftkings_label: 'TB Buccaneers', nfl_team_id: '4900' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/tb.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/TB.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/TB.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/a/a2/Tampa_Bay_Buccaneers_logo.svg/100px-Tampa_Bay_Buccaneers_logo.svg.png',
    },
  },
  {
    abbr: 'ARI',
    name: 'Arizona Cardinals',
    nickname: 'Cardinals',
    conference: 'NFC',
    division: 'NFC West',
    colors: { primary: '#97233F', secondary: '#000000', tertiary: '#ffb612', quaternary: '#a5acaf' },
    ids: { espn_abbr: 'ARI', draftkings_label: 'ARI Cardinals', nfl_team_id: '3800' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/ari.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/ARI.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/ARI.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/7/72/Arizona_Cardinals_logo.svg/179px-Arizona_Cardinals_logo.svg.png',
    },
  },
  {
    abbr: 'LAR',
    name: 'Los Angeles Rams',
    nickname: 'Rams',
    conference: 'NFC',
    division: 'NFC West',
    colors: { primary: '#003594', secondary: '#FFD100', tertiary: '#001532', quaternary: '#af925d' },
    ids: { espn_abbr: 'LAR', draftkings_label: 'LA Rams', nfl_team_id: '2510' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/lar.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/LAR.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/LAR.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8a/Los_Angeles_Rams_logo.svg/100px-Los_Angeles_Rams_logo.svg.png',
    },
  },
  {
    abbr: 'SF',
    name: 'San Francisco 49ers',
    nickname: '49ers',
    conference: 'NFC',
    division: 'NFC West',
    colors: { primary: '#AA0000', secondary: '#B3995D', tertiary: '#000000', quaternary: '#a5acaf' },
    ids: { espn_abbr: 'SF', draftkings_label: 'SF 49ers', nfl_team_id: '4500' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/sf.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/SF.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/SF.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/San_Francisco_49ers_logo.svg/100px-San_Francisco_49ers_logo.svg.png',
    },
  },
  {
    abbr: 'SEA',
    name: 'Seattle Seahawks',
    nickname: 'Seahawks',
    conference: 'NFC',
    division: 'NFC West',
    colors: { primary: '#002244', secondary: '#69be28', tertiary: '#a5acaf', quaternary: '#001532' },
    ids: { espn_abbr: 'SEA', draftkings_label: 'SEA Seahawks', nfl_team_id: '4600' },
    logos: {
      espn: 'https://a.espncdn.com/i/teamlogos/nfl/500/sea.png',
      wordmark: 'https://github.com/nflverse/nflverse-pbp/raw/master/wordmarks/SEA.png',
      squared: 'https://github.com/nflverse/nflverse-pbp/raw/master/squared_logos/SEA.png',
      wikipedia: 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8e/Seattle_Seahawks_logo.svg/100px-Seattle_Seahawks_logo.svg.png',
    },
  },
] as const;
