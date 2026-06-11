// One-off importer for the badminton-ettlingen.de participant list.
// Run with:  npx tsx scripts/import-ettlingen.ts
//
// Each "entry" on the source page becomes one Participant row. Doubles pairs
// are stored as "Player A & Player B" with combined club; solo doubles entries
// (registered without a partner) are kept as-is — the operator pairs them up
// later in the UI.
//
// Category encoding: <discipline>-<class>, e.g. "MS-A", "WD-C", "XD-B".

import { mutate } from '../admin/src/storage.ts';
import { nanoid } from 'nanoid';

type Entry = { name: string; club: string; category: string };

// Raw entries below carry combined "<CAT>-<CLASS>" codes (e.g. "WS-B");
// they're split into separate (category, class) fields at insert time.
// Source uses "XD" for mixed doubles; we map it to "MX".
const data: Entry[] = [
  // ---- Women's Singles ----
  { name: 'Abigail Zaslansky',         club: 'PS Karlsruhe',                category: 'WS-B' },
  { name: 'Alina Thiede',              club: 'TSV Neuhengstett',            category: 'WS-B' },
  { name: 'Eva Eichenlaub',            club: 'SV Viktoria Herxheim',        category: 'WS-B' },
  { name: 'Tatiana Kulikova',          club: 'BSV Eggenstein-Leopoldshafen',category: 'WS-B' },
  { name: 'Eva Kaltenbach',            club: 'TSV Neuhengstett',            category: 'WS-C' },
  { name: 'Franziska Metz',            club: 'SV Viktoria Herxheim',        category: 'WS-C' },
  { name: 'Natalie Feuerstein',        club: 'VfL Sindelfingen',            category: 'WS-C' },
  { name: 'Pia Skuthan',               club: 'VfL Sindelfingen',            category: 'WS-C' },

  // ---- Men's Singles, A-Klasse ----
  { name: 'Ben Seyffert',              club: 'SG Schorndorf',               category: 'MS-A' },
  { name: 'Eric Herrgoß',              club: 'TSV Neuhengstett',            category: 'MS-A' },
  { name: 'Frank Hagemeister',         club: 'TuS Metzingen',               category: 'MS-A' },
  { name: 'Jan Huttenloch',            club: 'SSV Ettlingen',               category: 'MS-A' },
  { name: 'Jan Marc Arenth',           club: 'SV Viktoria Herxheim',        category: 'MS-A' },
  { name: 'Julian Bell',               club: 'BV Rastatt',                  category: 'MS-A' },
  { name: 'Lino Dilk',                 club: 'PS Karlsruhe',                category: 'MS-A' },
  { name: 'Lion Rullkötter',           club: 'Spvgg Mössingen',             category: 'MS-A' },
  { name: 'Lukas Ast',                 club: 'OSC München',                 category: 'MS-A' },
  { name: 'Manuel Beinert',            club: 'TSG Dossenheim',              category: 'MS-A' },
  { name: 'Maximilian Schwing',        club: 'SSV Ettlingen',               category: 'MS-A' },
  { name: 'Michael Knoth',             club: 'VfL Sindelfingen',            category: 'MS-A' },
  { name: 'Mika Julian Tiegs',         club: 'Spvgg Mössingen',             category: 'MS-A' },
  { name: 'Nico Weber',                club: 'SSV Ettlingen',               category: 'MS-A' },
  { name: 'Niklas Haug',               club: 'Spvgg Mössingen',             category: 'MS-A' },
  { name: 'Otto Kaltenbach',           club: 'VfL Herrenberg',              category: 'MS-A' },
  { name: 'Patrick Heimann',           club: 'KSG Gerlingen',               category: 'MS-A' },
  { name: 'Pavan Kumar Dasari',        club: 'FSV Waiblingen',              category: 'MS-A' },
  { name: 'Thomas Caruyer',            club: 'PS Karlsruhe',                category: 'MS-A' },
  { name: 'Torben Berndt',             club: 'TSG Dossenheim',              category: 'MS-A' },
  { name: 'Yannick Haag',              club: 'SG Schorndorf',               category: 'MS-A' },

  // ---- Men's Singles, B-Klasse ----
  { name: 'Christian Bornhöfft',       club: 'ASV Landau',                  category: 'MS-B' },
  { name: 'Dat Nguyen',                club: 'TB Sinzheim',                 category: 'MS-B' },
  { name: 'Dennis Moschina',           club: 'BSV Eggenstein-Leopoldshafen',category: 'MS-B' },
  { name: 'Dung Manh Hoang',           club: 'MTV Stuttgart',               category: 'MS-B' },
  { name: 'Ergin Demir',               club: 'TSG Heilbronn',               category: 'MS-B' },
  { name: 'Fabio Kunzmann',            club: 'Ena Bad',                     category: 'MS-B' },
  { name: 'Florian Feuerstein',        club: 'VfL Sindelfingen',            category: 'MS-B' },
  { name: 'Jacob Götz',                club: 'SV Viktoria Herxheim',        category: 'MS-B' },
  { name: 'Jannik Wenig',              club: 'ASV Landau',                  category: 'MS-B' },
  { name: 'Jannis Burkart',            club: 'BSV Eggenstein-Leopoldshafen',category: 'MS-B' },
  { name: 'Jonathan Schaab',           club: 'HSV Mainz',                   category: 'MS-B' },
  { name: 'Kevin Rudolph',             club: 'TSG Heilbronn',               category: 'MS-B' },
  { name: 'Khue Ngo',                  club: 'SSC Karlsruhe',               category: 'MS-B' },
  { name: 'Liam Ressel',               club: 'SSC Karlsruhe',               category: 'MS-B' },
  { name: 'Pierre Schmidt',            club: 'BV Rastatt',                  category: 'MS-B' },
  { name: 'Tobias Strileckyj',         club: 'VfL Sindelfingen',            category: 'MS-B' },
  { name: 'Tristan Brecht',            club: 'ASV Landau',                  category: 'MS-B' },
  { name: 'Vivekananda Mysore Venkataramu', club: 'BSG Sinzheim/Bühl',      category: 'MS-B' },

  // ---- Men's Singles, C-Klasse ----
  { name: 'Andrii Tkachenko',          club: 'BV Rastatt',                  category: 'MS-C' },
  { name: 'Daniel Gabor',              club: 'VfL Sindelfingen',            category: 'MS-C' },
  { name: 'Daniel Misof',              club: 'DJK Offenburg',               category: 'MS-C' },
  { name: 'Daniel Schäfer',            club: 'TuS Bietigheim',              category: 'MS-C' },
  { name: 'Guido Schweitzer',          club: 'SSV Ettlingen',               category: 'MS-C' },
  { name: 'Hans Alfred Kaufmes',       club: 'MTV Stuttgart',               category: 'MS-C' },
  { name: 'Huniar Huniar',             club: 'BV Achern',                   category: 'MS-C' },
  { name: 'Jash Pranavkumar Jani',     club: 'Heidelberg TV',               category: 'MS-C' },
  { name: 'Jonas Pipat-Tang Czikl',    club: 'MTV Stuttgart',               category: 'MS-C' },
  { name: 'Karl Eck',                  club: 'SV Viktoria Herxheim',        category: 'MS-C' },
  { name: 'Kenk Lim',                  club: 'TB Sinzheim',                 category: 'MS-C' },
  { name: 'Köhler Johannes',           club: '',                            category: 'MS-C' },
  { name: 'Luca Haist',                club: 'TV Busenbach',                category: 'MS-C' },
  { name: 'Moritz Spohn',              club: 'SVK Beiertheim',              category: 'MS-C' },
  { name: 'Paul Pierret',              club: 'BV Rastatt',                  category: 'MS-C' },
  { name: 'Quentin Schnell',           club: 'VfL Sindelfingen',            category: 'MS-C' },
  { name: 'Rieberger Andre',           club: 'TV Rottenburg',               category: 'MS-C' },
  { name: 'Rohith Charan Desireddy',   club: 'BSG Sinzheim/Bühl',           category: 'MS-C' },
  { name: 'Sanjiv Kumar',              club: 'BSV Eggenstein-Leopoldshafen',category: 'MS-C' },
  { name: 'Silvano Haist',             club: 'TV Busenbach',                category: 'MS-C' },
  { name: 'Velmurugan Narayanasamy',   club: 'SportKultur Stuttgart',       category: 'MS-C' },
  { name: 'Yannik Görz',               club: 'TV Rottenburg',               category: 'MS-C' },
  { name: 'Yuan Yicheng',              club: 'MTV Stuttgart',               category: 'MS-C' },

  // ---- Women's Doubles, A-Klasse ----
  { name: 'Eileen Behrendt & Felicia Veres',     club: 'BV Rastatt',                          category: 'WD-A' },
  { name: 'Karolin Blaich & Sabrina Albrecht',   club: 'TSV Neuhausen / TSG Heilbronn',       category: 'WD-A' },
  { name: 'Samira Schilli & Sofiia Malinina',    club: 'BC Offenburg / Spvgg Mössingen',      category: 'WD-A' },
  { name: 'Franca Singer & Rositsa Tinkova',     club: 'TSV Diedorf / SSV Ettlingen',         category: 'WD-A' },

  // ---- Women's Doubles, B-Klasse ----
  { name: 'Chatrawee Scheiger & Samurkae Crocoll', club: 'BSV Eggenstein-Leopoldshafen',      category: 'WD-B' },
  { name: 'Charlotte Gräßle & Theresa Gräßle',     club: 'TSG Heilbronn',                     category: 'WD-B' },
  { name: 'Petra Kunzmann & Alina Thiede',         club: 'Ena Bad / TSV Neuhengstett',        category: 'WD-B' },

  // ---- Women's Doubles, C-Klasse ----
  { name: 'Betsy Sanjaya & Yenni Tjandra',         club: 'Hobby',                             category: 'WD-C' },
  { name: 'Franziska Metz & Savitree Techa',       club: 'SV Viktoria Herxheim',              category: 'WD-C' },
  { name: 'Natalie Feuerstein & Pia Skuthan',      club: 'VfL Sindelfingen',                  category: 'WD-C' },
  { name: 'Danqing Liu & Jiasi Xu',                club: 'BC Spöck',                          category: 'WD-C' },

  // ---- Men's Doubles, A-Klasse ----
  { name: 'Jakob Geukes & Maximilian Schwing',     club: 'SSV Ettlingen',                                category: 'MD-A' },
  { name: 'Markus Kexel & Pascal Dohms',           club: 'BV Rastatt',                                   category: 'MD-A' },
  { name: 'Kevin Schneider & Shota Ito',           club: 'BV Rastatt',                                   category: 'MD-A' },
  { name: 'Eric Herrgoß & Otto Kaltenbach',        club: 'TSV Neuhengstett / VfL Herrenberg',            category: 'MD-A' },
  { name: 'Manuel Beinert & Torben Berndt',        club: 'TSG Dossenheim',                               category: 'MD-A' },
  { name: 'Jan Marc Arenth & Sebastian Collet',    club: 'SV Viktoria Herxheim',                         category: 'MD-A' },
  { name: 'Kai Liu & Xiaoyue Ji',                  club: 'SSC Karlsruhe / OSC München',                  category: 'MD-A' },
  { name: 'Daniel Göricke & Martin Hähnel',        club: 'Spvgg Mössingen',                              category: 'MD-A' },
  { name: 'Lion Rullkötter & Mika Julian Tiegs',   club: 'Spvgg Mössingen',                              category: 'MD-A' },
  { name: 'Patrick Bergmann & Patrick Heimann',    club: 'TSV Bietigheim-Kleiningersheim / KSG Gerlingen', category: 'MD-A' },
  { name: 'Fabio Kunzmann & Ben Seyffert',         club: 'Ena Bad / SG Schorndorf',                      category: 'MD-A' },
  { name: 'Fabian Seeling & Jan Huttenloch',       club: 'SSV Ettlingen',                                category: 'MD-A' },
  { name: 'Frank Hagemeister & Yannick Haag',      club: 'TuS Metzingen / SG Schorndorf',                category: 'MD-A' },
  { name: 'Bodo Schindler & Lukas Ast',            club: 'KWO Berlin Köpenick / OSC München',            category: 'MD-A' },

  // ---- Men's Doubles, B-Klasse ----
  { name: 'Khue Ngo & Liam Ressel',                club: 'SSC Karlsruhe',                       category: 'MD-B' },
  { name: 'Andrew Issac & Noah Bauer',             club: 'BV Rastatt',                          category: 'MD-B' },
  { name: 'Dirk Wieland & Jochen Mackert',         club: 'SSV Ettlingen',                       category: 'MD-B' },
  { name: 'Christian Eichenlaub & Patrik Eichenlaub', club: 'SV Viktoria Herxheim',             category: 'MD-B' },
  { name: 'Laurin Rittershofer',                   club: 'SSV Waghäusel',                       category: 'MD-B' },
  { name: 'Tristan Brecht & Jannik Wenig',         club: 'ASV Landau',                          category: 'MD-B' },
  { name: 'Julien Morio',                          club: 'ASV Landau',                          category: 'MD-B' },
  { name: 'Jingui Yang & Tianran Wei',             club: 'BC Spöck',                            category: 'MD-B' },
  { name: 'Leo Weiske & Sebastian Senst',          club: 'BSV Eggenstein-Leopoldshafen',        category: 'MD-B' },
  { name: 'Jürgen Daust & Timm Lübben',            club: 'SSV Ettlingen',                       category: 'MD-B' },
  { name: 'Manish',                                club: 'BSV Eggenstein-Leopoldshafen',        category: 'MD-B' },
  { name: 'Boddapati Bhargav',                     club: 'BSV Eggenstein-Leopoldshafen',        category: 'MD-B' },
  { name: 'Abin Babu & Anas Muhammad Sabith',      club: 'MTV Stuttgart',                       category: 'MD-B' },
  { name: 'Lino Dilk & Thomas Caruyer',            club: 'PS Karlsruhe',                        category: 'MD-B' },
  { name: 'Ergin Demir & Marc Schebesch',          club: 'TSG Heilbronn',                       category: 'MD-B' },
  { name: 'Christian Attig & Michael Schäfer',     club: 'SSV Ettlingen',                       category: 'MD-B' },
  { name: 'Jannis Burkart & Tobias Manole',        club: 'BSV Eggenstein-Leopoldshafen',        category: 'MD-B' },
  { name: 'Viet Hung Nguyen',                      club: 'VfL Sindelfingen',                    category: 'MD-B' },
  { name: 'Vivekananda Mysore Venkataramu',        club: 'BSG Sinzheim/Bühl',                   category: 'MD-B' },
  { name: 'Florian Feuerstein & Tobias Strileckyj',club: 'VfL Sindelfingen',                    category: 'MD-B' },
  { name: 'Quentin Schnell & Tobias Zebisch',      club: 'VfL Sindelfingen',                    category: 'MD-B' },
  { name: 'Peter Leutner',                         club: 'BSG Sinzheim/Bühl',                   category: 'MD-B' },
  { name: 'Zhichao Chen',                          club: 'BSG Sinzheim/Bühl',                   category: 'MD-B' },
  { name: 'Aravind Menon & Ashwani Sharma',        club: 'BSG Sinzheim/Bühl',                   category: 'MD-B' },
  { name: 'Pavan Kumar Dasari & Mohan Halaguru Nagendra', club: 'FSV Waiblingen',               category: 'MD-B' },

  // ---- Men's Doubles, C-Klasse ----
  { name: 'Rieberger Andre & Yannik Görz',         club: 'TV Rottenburg',                       category: 'MD-C' },
  { name: 'Andrii Tkachenko & Paul Pierret',       club: 'BV Rastatt',                          category: 'MD-C' },
  { name: 'Michel Roelse & Stefan Karcher',        club: 'SSV Ettlingen',                       category: 'MD-C' },
  { name: 'Kuppuraj Srinivasan',                   club: 'TV Echterdingen',                     category: 'MD-C' },
  { name: 'Ravi Kumar Vaddepalli',                 club: 'BV Mühlacker',                        category: 'MD-C' },
  { name: 'Lianqi Ren & Zhenchong Li',             club: 'BSG Mannheim',                        category: 'MD-C' },
  { name: 'Dung Manh Hoang',                       club: 'MTV Stuttgart',                       category: 'MD-C' },
  { name: 'Jonas Pipat-Tang Czikl',                club: 'MTV Stuttgart',                       category: 'MD-C' },
  { name: 'Christoph Schynol',                     club: '',                                    category: 'MD-C' },
  { name: 'Manuel Bender',                         club: '',                                    category: 'MD-C' },
  { name: 'Daniel Schäfer & Nicolas Schmitt',      club: 'TuS Bietigheim',                      category: 'MD-C' },
  { name: 'Jithinlal Dev Puthanpura & Souvik Dey', club: 'TV Tamm',                             category: 'MD-C' },
  { name: 'Janakiram Chunchu & Sravan Kumar Kotapati', club: 'BV Lampertheim',                  category: 'MD-C' },
  { name: 'Li Pinyu & Nguyen An Bao',              club: 'SSC Karlsruhe',                       category: 'MD-C' },
  { name: 'Guido Schweitzer',                      club: 'SSV Ettlingen',                       category: 'MD-C' },
  { name: 'Dominic Wieroschewski',                 club: 'BV Rastatt',                          category: 'MD-C' },
  { name: 'Chang Li & Daniel Gabor',               club: 'VfL Sindelfingen',                    category: 'MD-C' },
  { name: 'Gyerak Laszlo & Sadat Hasan',           club: 'TV Neckargemünd',                     category: 'MD-C' },
  { name: 'Cheng Feng',                            club: 'BSG Sinzheim/Bühl',                   category: 'MD-C' },
  { name: 'Swastik Gandhi',                        club: 'Ski Club Bühl',                       category: 'MD-C' },
  { name: 'Moritz Spohn & Nils Koepke',            club: 'SVK Beiertheim',                      category: 'MD-C' },
  { name: 'Beini Ma & Deniz Saktan',               club: 'TV Pfortz Maximiliansau',             category: 'MD-C' },
  { name: 'Benny Mitternacht & Udo Schiffer',      club: 'Hobby',                               category: 'MD-C' },
  { name: 'Gerhard Zimmermann & Christian Krepper',club: 'SSV Ettlingen',                       category: 'MD-C' },

  // ---- Mixed Doubles, A-Klasse ----
  { name: 'Eileen Behrendt & Kevin Schneider',     club: 'BV Rastatt',                          category: 'XD-A' },
  { name: 'Alisa Geiger & Eric Herrgoß',           club: 'TSV Neuhengstett',                    category: 'XD-A' },
  { name: 'Bodo Schindler',                        club: 'KWO Berlin Köpenick',                 category: 'XD-A' },
  { name: 'Sabrina Albrecht',                      club: 'TSG Heilbronn',                       category: 'XD-A' },
  { name: 'Franca Singer',                         club: 'TSV Diedorf',                         category: 'XD-A' },
  { name: 'Patrick Heimann',                       club: 'KSG Gerlingen',                       category: 'XD-A' },
  { name: 'Julian Bell & Felicia Veres',           club: 'BV Rastatt',                          category: 'XD-A' },
  { name: 'Daniel Göricke & Sofiia Malinina',      club: 'Spvgg Mössingen',                     category: 'XD-A' },
  { name: 'Manuel Beinert',                        club: 'TSG Dossenheim',                      category: 'XD-A' },
  { name: 'Martina Malz-Lainer',                   club: 'TV Neckargemünd',                     category: 'XD-A' },
  { name: 'Lintao Toni Fan',                       club: 'BSpfr. Neusatz-Bad Herrenalb',        category: 'XD-A' },
  { name: 'Suratchanee Sungworn',                  club: 'SSC Karlsruhe',                       category: 'XD-A' },
  { name: 'Carla Rüeck & Pascal Dohms',            club: 'SSV Ettlingen / BV Rastatt',          category: 'XD-A' },
  { name: 'Markus Kexel',                          club: 'BV Rastatt',                          category: 'XD-A' },
  { name: 'Theresa Gräßle',                        club: 'TSG Heilbronn',                       category: 'XD-A' },

  // ---- Mixed Doubles, B-Klasse ----
  { name: 'Andrew Issac & Ida Lauer',              club: 'BV Rastatt',                          category: 'XD-B' },
  { name: 'Eva Eichenlaub & Patrik Eichenlaub',    club: 'SV Viktoria Herxheim',                category: 'XD-B' },
  { name: 'Jiasi Xu & Tianran Wei',                club: 'BC Spöck',                            category: 'XD-B' },
  { name: 'Danqing Liu & Jingui Yang',             club: 'BC Spöck',                            category: 'XD-B' },
  { name: 'Melanie Senst & Sebastian Senst',       club: 'BSV Eggenstein-Leopoldshafen',        category: 'XD-B' },
  { name: 'Dennis Moschina & Yvonne Geimer',       club: 'BSV Eggenstein-Leopoldshafen',        category: 'XD-B' },
  { name: 'Boddapati Bhargav & Borbora Angana',    club: 'BSV Eggenstein-Leopoldshafen',        category: 'XD-B' },
  { name: 'Mara Brand & Philipp Martens',          club: 'SSV Ettlingen',                       category: 'XD-B' },
  { name: 'Brigitte Scherer & Julien Morio',       club: 'ASV Landau',                          category: 'XD-B' },
  { name: 'Charlotte Gräßle & Marc Schebesch',     club: 'TSG Heilbronn',                       category: 'XD-B' },
  { name: 'Dwi Ardi Setiawan',                     club: 'TUS Stuttgart',                       category: 'XD-B' },
  { name: 'Ludwina Nuranissa',                     club: '',                                    category: 'XD-B' },
  { name: 'Christian Rodrian',                     club: 'TB Sinzheim',                         category: 'XD-B' },
  { name: 'Melina Yakar',                          club: 'BV Achern',                           category: 'XD-B' },
  { name: 'Natalie Feuerstein & Tobias Strileckyj',club: 'VfL Sindelfingen',                    category: 'XD-B' },
  { name: 'Florian Feuerstein & Pia Skuthan',      club: 'VfL Sindelfingen',                    category: 'XD-B' },
  { name: 'Xinxin Jing & Man Song',                club: '',                                    category: 'XD-B' },
  { name: 'Qinlan Kang & Yunfeng Ma',              club: 'Xxam Karlsdorf',                      category: 'XD-B' },

  // ---- Mixed Doubles, C-Klasse ----
  { name: 'Prasad Hegde',                          club: 'SSC Karlsruhe',                       category: 'XD-C' },
  { name: 'Yenni Tjandra',                         club: 'Hobby',                               category: 'XD-C' },
  { name: 'Markus Hintz & Tamara Rieger',          club: 'TSV Wimsheim',                        category: 'XD-C' },
  { name: 'Beate Brecht & Werner Ralf',            club: 'SG Schorndorf',                       category: 'XD-C' },
  { name: 'Franziska Metz & Jacob Götz',           club: 'SV Viktoria Herxheim',                category: 'XD-C' },
  { name: 'Alex Nicolay & Karl Eck',               club: 'SV Viktoria Herxheim',                category: 'XD-C' },
  { name: 'Martina Häfner & Thomas Häfner',        club: 'TuS Schaidt 08',                      category: 'XD-C' },
  { name: 'Roger Linz & Yuni Widiastuti',          club: 'TV Mörsch',                           category: 'XD-C' },
  { name: 'Fabio Kunzmann & Petra Kunzmann',       club: 'Ena Bad',                             category: 'XD-C' },
  { name: 'Cheng Feng & Ketty Wenhua Tang',        club: 'TB Sinzheim',                         category: 'XD-C' },
  { name: 'Alina Thiede',                          club: 'TSV Neuhengstett',                    category: 'XD-C' },
  { name: 'Quentin Schnell & Florian Wolff',       club: 'VfL Sindelfingen',                    category: 'XD-C' },
  { name: 'Martina Beilharz',                      club: 'VfL Sindelfingen',                    category: 'XD-C' },
  { name: 'Johannes Nguyen & Thi Nhat Anh Do',     club: 'TV Pfortz Maximiliansau',             category: 'XD-C' },
  { name: 'Lotta Gerstner & Tommy Tran',           club: 'TV Mörsch',                           category: 'XD-C' },
  { name: 'Monique Eby & Quang Tung Do',           club: 'TV Pfortz Maximiliansau',             category: 'XD-C' },
];

const CAT_RENAME: Record<string, string> = { XD: 'MX' };

function split(code: string): { category: string; class: string } {
  const m = code.match(/^([A-Za-z]+)(?:-([A-Za-z]))?$/);
  if (!m) return { category: code, class: '' };
  const cat = (CAT_RENAME[m[1].toUpperCase()] ?? m[1].toUpperCase());
  return { category: cat, class: (m[2] ?? '').toUpperCase() };
}

const next = await mutate(
  { action: 'import_ettlingen', target: '', payload: { count: data.length, source: 'badminton-ettlingen.de/teilnehmerliste/' } },
  (s) => {
    for (const e of data) {
      const { category, class: cls } = split(e.category);
      s.participants.push({
        id: nanoid(8),
        name: e.name,
        club: e.club,
        category,
        class: cls,
        seed: 0,
        withdrawn: false,
      });
    }
    s.tournament.name = 'Badminton Ettlingen';
    return s;
  },
);

console.log(`imported ${data.length} participants → total now ${next.participants.length}`);
const byCat = new Map<string, number>();
for (const p of next.participants) {
  const key = `${p.category}-${p.class || '·'}`;
  byCat.set(key, (byCat.get(key) ?? 0) + 1);
}
for (const [cat, n] of [...byCat].sort()) console.log(`  ${cat}: ${n}`);
