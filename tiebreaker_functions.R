library(dplyr)
library(tidyr)

# Function to update standings based on simulated results
update_standings <- function(standings, simulated_results, team_names) {
  updated_standings <- standings
  for (i in 1:nrow(simulated_results)) {
    team <- team_names[i]
    team_results <- simulated_results[i, ]
    wins <- sum(team_results == "Win")
    losses <- sum(team_results == "Loss") 
    updated_standings[updated_standings$Team == team, "Win"] <- updated_standings[updated_standings$Team == team, "Win"] + wins
    updated_standings[updated_standings$Team == team, "Loss"] <- updated_standings[updated_standings$Team == team, "Loss"] + losses
  }
  return(updated_standings)
}


determine_playoff_qualifiers <- function(standings, final_game_results, new_scores) {
  # Split standings by conference
  afc_teams <- standings[grep("AFC", standings$Division), ]
  nfc_teams <- standings[grep("NFC", standings$Division), ]
  
  get_playoff_teams <- function(conference_teams, game_results, new_scores) {
    # Calculate win percentage and order teams by it
    ordered_teams <- conference_teams %>%
      mutate(Win_Percentage = Win / (Win + Loss)) %>%
      arrange(desc(Win_Percentage), Loss) %>%
      group_by(Division)
    
    # Determine division winners, resolve ties only if there's an actual tie in winning percentage
    division_winners <- ordered_teams %>%
      do({
        top_win_percentage <- max(.$Win_Percentage)
        top_teams <- filter(., Win_Percentage == top_win_percentage)
        resolved_teams <- if(nrow(top_teams) > 1) {
          resolve_ties(top_teams, game_results, new_scores)
        } else {
          top_teams
        }
      }) %>%
      slice_head(n=1) %>%
      ungroup()
    
    
    # Order division winners based on the tiebreaker rules
    ordered_division_winners <- division_winners %>%
      group_by(Win_Percentage) %>%
      do({
        tied_teams <- .[nrow(.) > 1, ]
        if (nrow(tied_teams) > 1) {
          resolved_ties <- resolve_ties(tied_teams, game_results, new_scores)
        } else {
          tied_teams
        }
      }) %>%
      ungroup()
    
    # Assuming ordered_division_winners contains the sorted tiebreaker teams
    tiebreaker_teams <- ordered_division_winners$Team
    
    # Identify the teams involved in a tiebreaker within division_winners
    division_winners <- division_winners %>%
      mutate(Tiebreaker_Order = ifelse(Team %in% tiebreaker_teams, 
                                       match(Team, tiebreaker_teams),
                                       NA_integer_))
    
    division_winners <- division_winners %>%
      arrange(Tiebreaker_Order) %>%
      dplyr::select(-Tiebreaker_Order) %>%
      arrange(desc(Win_Percentage))
    
    # Determine potential wild card teams
    potential_wild_cards <- ordered_teams %>%
      filter(!Team %in% division_winners$Team) %>%
      ungroup()
    
    # Resolve ties for wild cards, only if there's a tie in winning percentage
    wild_cards <- potential_wild_cards %>%
      group_by(Win_Percentage) %>%
      do({
        tied_teams <- .[nrow(.) > 1, ]
        if (nrow(tied_teams) > 1) {
          resolved_ties <- resolve_ties(tied_teams, game_results, new_scores)
        } else {
          tied_teams
        }
      }) %>%
      ungroup()
    
    # Creating a tiebreaker order for teams based on the resolved ties
    tiebreaker_teams <- wild_cards$Team
    wild_cards <- potential_wild_cards %>%
      mutate(Tiebreaker_Order = ifelse(Team %in% tiebreaker_teams, 
                                       match(Team, tiebreaker_teams),
                                       NA_integer_)) %>%
      arrange(Tiebreaker_Order) %>%
      select(-Tiebreaker_Order) %>%
      arrange(desc(Win_Percentage))
    
    # Combine ordered division winners and wild cards
    combined_teams <- bind_rows(division_winners, wild_cards) %>%
      mutate(seed = row_number()) %>%
      slice_head(n=7)
    
    return(combined_teams)
  }
  
  
  afc_playoff_teams <- get_playoff_teams(afc_teams, final_game_results, new_scores)
  nfc_playoff_teams <- get_playoff_teams(nfc_teams, final_game_results, new_scores)
  
  return(list(afc = afc_playoff_teams, nfc = nfc_playoff_teams))
}

resolve_ties <- function(teams, game_results, new_scores, is_top_level = TRUE) {
  if (nrow(teams) <= 1) {
    if (is_top_level) {
      cat("Final order of teams after resolving all ties:", paste(teams$Team, collapse = ", "), "\n\n")
    }
    return(teams)
  }
  
  cat("Resolving ties for", nrow(teams), "teams:", paste(teams$Team, collapse = ", "), "\n")
  
  # Check head-to-head record first
  h2h_matrix <- matrix(0, nrow = nrow(teams), ncol = nrow(teams))
  rownames(h2h_matrix) <- teams$Team
  colnames(h2h_matrix) <- teams$Team
  
  for (i in 1:nrow(teams)) {
    for (j in 1:nrow(teams)) {
      if (i != j) {
        team1_name <- teams$Team[i]
        team2_name <- teams$Team[j]
        head_to_head_games <- game_results[
          (game_results$Team1 == team1_name & game_results$Team2 == team2_name) |
            (game_results$Team1 == team2_name & game_results$Team2 == team1_name), ]
        
        team1_wins <- sum(head_to_head_games$Winner == team1_name)
        team2_wins <- sum(head_to_head_games$Winner == team2_name)
        
        h2h_matrix[i, j] <- team1_wins - team2_wins
      }
    }
  }
  
  # Determine the team with the highest head-to-head win count
  h2h_wins <- rowSums(h2h_matrix > 0, na.rm = TRUE)
  max_h2h_wins <- max(h2h_wins)
  total_h2h_wins <- sum(h2h_wins) / 2
  #print(h2h_matrix)
  #print(h2h_wins)
  #print(max_h2h_wins)
  #print(total_h2h_wins)
  
  if (nrow(teams) == 2) {
    if (max_h2h_wins > total_h2h_wins) {
      winner_team <- teams$Team[which(h2h_wins == max_h2h_wins)]
      cat("Head-to-head winner:", winner_team, "\n")
    } else {
      # Use total points as tiebreaker
      teams$Total_Points <- sapply(teams$Team, function(team) sum(new_scores[new_scores$Team == team, -c(1:3)], na.rm = TRUE))
      winner_team <- teams$Team[which.max(teams$Total_Points)]
      cat("No head-to-head winner. Tie broken by total points. Winner:", winner_team, "\n")
    }
  } else {
    if (max_h2h_wins > nrow(teams) / 2) {
      winner_team <- teams$Team[which(h2h_wins == max_h2h_wins)]
      cat("Head-to-head winner:", winner_team, "\n")
    } else {
      # Use total points as tiebreaker
      teams$Total_Points <- sapply(teams$Team, function(team) sum(new_scores[new_scores$Team == team, -c(1:3)], na.rm = TRUE))
      winner_team <- teams$Team[which.max(teams$Total_Points)]
      cat("No head-to-head winner. Tie broken by total points. Winner:", winner_team, "\n")
    }
  }
  
  
  # Remove the winning team and resolve remaining ties
  remaining_teams <- teams[!teams$Team %in% winner_team, ]
  cat("Remaining teams for next iteration:", paste(remaining_teams$Team, collapse = ", "), "\n")
  remaining_teams <- resolve_ties(remaining_teams, game_results, new_scores, is_top_level = FALSE)
  
  # Combine the winner with the remaining teams
  resolved_teams <- bind_rows(teams[teams$Team %in% winner_team, ], remaining_teams)
  
  # Display the final order only when the top-level call finishes
  if (is_top_level) {
    cat("Final order of teams after resolving all ties:", paste(resolved_teams$Team, collapse = ", "), "\n\n")
  }
  
  return(resolved_teams)
}
