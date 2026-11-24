[out:json][timeout:180];
// IIT Bhubaneswar campus outline (amenity=university)
way(621537202)->.cw;
.cw map_to_area->.c;
(
  nwr[building](area.c);
  way[highway](area.c);
  nwr[landuse](area.c);
  nwr[leisure](area.c);
  nwr[natural](area.c);
  nwr[amenity](area.c);
  nwr[shop](area.c);
  nwr[tourism](area.c);
  nwr[office](area.c);
  nwr[healthcare](area.c);
  nwr[sport](area.c);
  nwr[man_made](area.c);
  nwr[power](area.c);
  way[waterway](area.c);
  way[barrier](area.c);
  node(area.c)[~"."~"."];
  .cw;
)->.inside;
// a little context around the campus
(
  way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)(_link)?$"](20.1371,85.6525,20.1588,85.6877);
  way[railway~"^(rail|light_rail)$"](20.1371,85.6525,20.1588,85.6877);
  nwr[natural=water](20.1371,85.6525,20.1588,85.6877);
  nwr[landuse~"^(forest|reservoir|basin)$"](20.1371,85.6525,20.1588,85.6877);
  nwr[building](20.1371,85.6525,20.1588,85.6877);
)->.around;
(.inside; .around;);
out body;
>;
out skel qt;
