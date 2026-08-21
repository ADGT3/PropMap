/**
 * data.js
 * Property listings data for the Sydney Property Map.
 *
 * Each listing has a `zone` field matching an id in the ZONES array in overlays.js.
 */

const listings = [
  // Parramatta
  { id:1,  address:"34 Pennant Hills Rd",        suburb:"Parramatta",      price:"$1,480,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8130, lng:151.0025, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:2,  address:"12/45 Church St",             suburb:"Parramatta",      price:"$680,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-33.8172, lng:151.0045, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:3,  address:"8 Victoria Rd",               suburb:"Parramatta",      price:"$1,250,000", type:"house",     beds:3, baths:2, cars:2, lat:-33.8195, lng:150.9990, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:4,  address:"203/2 Hassall St",            suburb:"Parramatta",      price:"$595,000",   type:"apartment", beds:1, baths:1, cars:1, lat:-33.8155, lng:151.0010, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Blacktown
  { id:5,  address:"22 Flushcombe Rd",            suburb:"Blacktown",       price:"$920,000",   type:"house",     beds:3, baths:1, cars:2, lat:-33.8100, lng:150.9080, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:6,  address:"15 Prince St",                suburb:"Blacktown",       price:"$860,000",   type:"house",     beds:3, baths:2, cars:1, lat:-33.8150, lng:150.9050, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:7,  address:"4/10 Campbell St",            suburb:"Blacktown",       price:"$510,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-33.8080, lng:150.9110, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Castle Hill / Hills District
  { id:8,  address:"47 Showground Rd",            suburb:"Castle Hill",     price:"$1,920,000", type:"house",     beds:5, baths:3, cars:2, lat:-33.8200, lng:151.0040, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:9,  address:"11 Old Northern Rd",          suburb:"Castle Hill",     price:"$1,650,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8250, lng:151.0070, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:10, address:"3/18 Cecil Ave",              suburb:"Castle Hill",     price:"$820,000",   type:"apartment", beds:2, baths:2, cars:1, lat:-33.8220, lng:151.0010, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Kellyville / Norwest / Bella Vista
  { id:11, address:"88 Windsor Rd",               suburb:"Kellyville",      price:"$1,580,000", type:"house",     beds:5, baths:3, cars:2, lat:-33.8100, lng:150.9750, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:12, address:"12 Hezlett Rd",               suburb:"Kellyville Ridge",price:"$1,100,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8200, lng:150.9200, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:13, address:"14 Fairway Dr",               suburb:"Norwest",         price:"$1,450,000", type:"house",     beds:4, baths:3, cars:2, lat:-33.8300, lng:150.9700, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:14, address:"2/5 Lexington Dr",            suburb:"Bella Vista",     price:"$950,000",   type:"apartment", beds:3, baths:2, cars:2, lat:-33.8350, lng:150.9650, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Marsden Park / Schofields / Box Hill / Rouse Hill
  { id:15, address:"5 Elara Blvd",                suburb:"Marsden Park",    price:"$980,000",   type:"house",     beds:4, baths:2, cars:2, lat:-33.8100, lng:150.8430, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:16, address:"22 Rouse Hill Dr",            suburb:"Rouse Hill",      price:"$1,350,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8050, lng:150.9170, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:17, address:"Lot 12 Appin Rd",             suburb:"Box Hill",        price:"$750,000",   type:"land",      beds:0, baths:0, cars:0, lat:-33.8020, lng:150.9050, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:18, address:"77 Schofields Rd",            suburb:"Schofields",      price:"$1,020,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8100, lng:150.8690, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:19, address:"Lot 34 Commercial Rd",        suburb:"Box Hill",        price:"$620,000",   type:"land",      beds:0, baths:0, cars:0, lat:-33.8070, lng:150.8980, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:20, address:"9 Tallawong Ave",             suburb:"Rouse Hill",      price:"$1,150,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.8090, lng:150.9110, waterStatus:"planned",    zone:"south-west-sydney" },
  // Liverpool
  { id:21, address:"18 Bathurst St",              suburb:"Liverpool",       price:"$990,000",   type:"house",     beds:3, baths:2, cars:1, lat:-33.9210, lng:150.9240, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:22, address:"7/102 Macquarie St",          suburb:"Liverpool",       price:"$520,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-33.9230, lng:150.9260, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:23, address:"44 Elizabeth Dr",             suburb:"Liverpool",       price:"$880,000",   type:"house",     beds:3, baths:1, cars:2, lat:-33.9180, lng:150.9210, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Leppington / SW growth corridor
  { id:24, address:"23 Bernera Rd",               suburb:"Leppington",      price:"$890,000",   type:"house",     beds:4, baths:2, cars:2, lat:-33.9632, lng:150.7882, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:25, address:"15 Orion Rd",                 suburb:"Gregory Hills",   price:"$1,050,000", type:"house",     beds:4, baths:2, cars:2, lat:-34.0140, lng:150.8010, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:26, address:"31 Gledswood Hills Dr",       suburb:"Gledswood Hills", price:"$1,120,000", type:"house",     beds:4, baths:3, cars:2, lat:-34.0230, lng:150.7660, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:27, address:"Lot 45 Menangle Park",        suburb:"Menangle Park",   price:"$420,000",   type:"land",      beds:0, baths:0, cars:0, lat:-34.0150, lng:150.7300, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:28, address:"5 Oran Park Dr",              suburb:"Oran Park",       price:"$980,000",   type:"house",     beds:4, baths:2, cars:2, lat:-34.0270, lng:150.7610, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:29, address:"Lot 7 Camden Valley Way",     suburb:"Oran Park",       price:"$560,000",   type:"land",      beds:0, baths:0, cars:0, lat:-34.0310, lng:150.7550, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:30, address:"18 Cobbitty Rd",              suburb:"Cobbitty",        price:"$1,180,000", type:"house",     beds:4, baths:2, cars:2, lat:-34.0390, lng:150.6800, waterStatus:"unserviced", zone:"south-west-sydney" },
  { id:31, address:"Lot 22 Spring Farm Pkwy",     suburb:"Spring Farm",     price:"$490,000",   type:"land",      beds:0, baths:0, cars:0, lat:-34.0360, lng:150.7360, waterStatus:"planned",    zone:"south-west-sydney" },
  // Camden / Narellan / Harrington Park
  { id:32, address:"14 John St",                  suburb:"Camden",          price:"$870,000",   type:"house",     beds:3, baths:2, cars:2, lat:-34.0550, lng:150.6970, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:33, address:"5 Narellan Rd",               suburb:"Narellan",        price:"$920,000",   type:"house",     beds:4, baths:2, cars:2, lat:-34.0310, lng:150.7360, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:34, address:"Lot 3 Harrington Park Blvd",  suburb:"Harrington Park", price:"$1,050,000", type:"house",     beds:4, baths:2, cars:2, lat:-34.0220, lng:150.7480, waterStatus:"planned",    zone:"south-west-sydney" },
  // Campbelltown
  { id:35, address:"33 Queen St",                 suburb:"Campbelltown",    price:"$720,000",   type:"house",     beds:3, baths:1, cars:2, lat:-34.0650, lng:150.8140, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:36, address:"7/22 Broughton St",           suburb:"Campbelltown",    price:"$420,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-34.0630, lng:150.8120, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:37, address:"55 Kellicar Rd",              suburb:"Campbelltown",    price:"$780,000",   type:"house",     beds:4, baths:2, cars:2, lat:-34.0590, lng:150.8180, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Penrith
  { id:38, address:"120 High St",                 suburb:"Penrith",         price:"$890,000",   type:"house",     beds:4, baths:2, cars:2, lat:-33.8900, lng:150.6970, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:39, address:"3/15 Station St",             suburb:"Penrith",         price:"$540,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-33.8800, lng:150.6940, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Edmondson Park / Bardia / Austral
  { id:40, address:"Lot 101 Rampart St",          suburb:"Bardia",          price:"$780,000",   type:"land",      beds:0, baths:0, cars:0, lat:-33.9880, lng:150.8450, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:41, address:"6 Edmondson Ave",             suburb:"Edmondson Park",  price:"$1,050,000", type:"house",     beds:4, baths:2, cars:2, lat:-33.9720, lng:150.8620, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:42, address:"15 Town Centre Cct",          suburb:"Edmondson Park",  price:"$1,150,000", type:"house",     beds:4, baths:3, cars:2, lat:-33.9750, lng:150.8600, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:43, address:"Lot 19 Gurner Ave",           suburb:"Austral",         price:"$650,000",   type:"land",      beds:0, baths:0, cars:0, lat:-33.9600, lng:150.8200, waterStatus:"planned",    zone:"south-west-sydney" },
  { id:44, address:"32 Fifteenth Ave",            suburb:"Austral",         price:"$920,000",   type:"house",     beds:4, baths:2, cars:2, lat:-33.9560, lng:150.8250, waterStatus:"planned",    zone:"south-west-sydney" },
  // Fairfield / Cabramatta
  { id:45, address:"18 Smart St",                 suburb:"Fairfield",       price:"$960,000",   type:"house",     beds:4, baths:2, cars:2, lat:-33.8720, lng:150.9570, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:46, address:"9 John St",                   suburb:"Cabramatta",      price:"$880,000",   type:"house",     beds:3, baths:2, cars:1, lat:-33.8930, lng:150.9380, waterStatus:"serviced",   zone:"south-west-sydney" },
  // Merrylands / Wentworthville
  { id:47, address:"76 Merrylands Rd",            suburb:"Merrylands",      price:"$1,050,000", type:"house",     beds:3, baths:2, cars:2, lat:-33.8330, lng:150.9870, waterStatus:"serviced",   zone:"south-west-sydney" },
  { id:48, address:"5/20 Dunmore St",             suburb:"Wentworthville",  price:"$590,000",   type:"apartment", beds:2, baths:1, cars:1, lat:-33.8120, lng:150.9710, waterStatus:"serviced",   zone:"south-west-sydney" },
  // St Marys
  { id:49, address:"22 Mamre Rd",                 suburb:"St Marys",        price:"$820,000",   type:"house",     beds:3, baths:1, cars:2, lat:-33.8650, lng:150.7750, waterStatus:"serviced",   zone:"south-west-sydney" },
];

const waterLabels = {
  serviced:   "Design and Deliver",
  planned:    "Strategic Planning",
  unserviced: "Concept Planning",
  outside:    "Outside plan area"
};
